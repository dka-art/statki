// Statki online — Cloudflare Worker + Durable Object (jeden pokój = jedna gra 1 na 1)
import { DurableObject } from "cloudflare:workers";

const SIZE = 10;
const CELLS = SIZE * SIZE;
const FLEET = [5, 4, 3, 3, 2];
const SHIP_NAMES = ["Lotniskowiec", "Pancernik", "Krążownik", "Okręt podwodny", "Niszczyciel"];
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bez I, O, 0, 1
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const TOKEN_RE = /^[A-Za-z0-9-]{16,64}$/;
const IDLE_MS = 24 * 60 * 60 * 1000; // pokój znika po 24 h bez aktywności

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function cleanName(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16);
}

function newGame() {
  return { phase: "setup", rules: { again: true }, players: [], turn: null, winner: null, last: null };
}

function newPlayer(token, name) {
  return { token, name, ready: false, ships: [], incoming: new Array(CELLS).fill(0), rematch: false };
}

// Sprawdza ustawienie floty: 5 statków o właściwych długościach, proste, bez nakładania.
function validateShips(list) {
  if (!Array.isArray(list) || list.length !== FLEET.length) return null;
  const used = new Set();
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || !Number.isInteger(s.id) || s.id < 0 || s.id >= FLEET.length || seen.has(s.id)) return null;
    seen.add(s.id);
    const len = FLEET[s.id];
    if (!Array.isArray(s.cells) || s.cells.length !== len) return null;
    if (!s.cells.every((c) => Number.isInteger(c) && c >= 0 && c < CELLS)) return null;
    const cells = s.cells.slice().sort((a, b) => a - b);
    const sameRow = cells.every((c) => Math.floor(c / SIZE) === Math.floor(cells[0] / SIZE));
    const sameCol = cells.every((c) => c % SIZE === cells[0] % SIZE);
    if (!sameRow && !sameCol) return null;
    const step = sameRow ? 1 : SIZE;
    for (let k = 1; k < len; k++) if (cells[k] - cells[k - 1] !== step) return null;
    for (const c of cells) {
      if (used.has(c)) return null;
      used.add(c);
    }
    out.push({ id: s.id, cells });
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Nowa gra: tworzy kod pokoju i ustawia zasady.
    if (url.pathname === "/api/new" && request.method === "POST") {
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const code = makeCode();
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      await stub.fetch("https://room/init", {
        method: "POST",
        body: JSON.stringify({ again: body.again !== false }),
      });
      return json({ code });
    }

    // WebSocket do pokoju.
    const m = url.pathname.match(/^\/api\/ws\/([A-Za-z0-9]{6})$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: "Nieprawidłowy kod gry" }, 400);
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      return stub.fetch(request);
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "Nie znaleziono" }, 404);
    return env.ASSETS.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.game = newGame();
    // Odpowiedź na „ping” bez budzenia obiektu — utrzymuje połączenia przy życiu.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get("game");
      if (saved) this.game = saved;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init") {
      let body = {};
      try {
        body = await request.json();
      } catch {}
      if (this.game.players.length === 0) this.game.rules.again = body.again !== false;
      await this.save();
      return new Response("ok");
    }

    const token = url.searchParams.get("token") || "";
    if (!TOKEN_RE.test(token)) return new Response("Bad token", { status: 400 });
    const name = cleanName(url.searchParams.get("name"));

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const g = this.game;

    let idx = g.players.findIndex((p) => p.token === token);
    if (idx === -1) {
      if (g.players.length >= 2) {
        server.accept();
        server.send(JSON.stringify({ t: "full" }));
        server.close(1008, "full");
        return new Response(null, { status: 101, webSocket: client });
      }
      idx = g.players.length;
      g.players.push(newPlayer(token, name || `Gracz ${idx + 1}`));
    } else if (name) {
      g.players[idx].name = name;
    }

    this.ctx.acceptWebSocket(server, [token]);
    server.serializeAttachment({ idx });
    this.maybeStart();
    await this.save();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 4000) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment();
    if (!att || !this.game.players[att.idx]) return;
    const me = att.idx;

    let err = null;
    switch (msg && msg.t) {
      case "place":
        err = this.place(me, msg.ships);
        break;
      case "unplace":
        err = this.unplace(me);
        break;
      case "fire":
        err = this.fire(me, msg.idx);
        break;
      case "rematch":
        err = this.rematch(me);
        break;
      default:
        return;
    }
    if (err) {
      try {
        ws.send(JSON.stringify({ t: "error", msg: err }));
      } catch {}
      return;
    }
    await this.save();
    this.broadcast();
  }

  async webSocketClose(ws) {
    try {
      ws.close(1000, "bye");
    } catch {}
    this.broadcast();
  }

  async webSocketError() {
    this.broadcast();
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "Pokój wygasł");
      } catch {}
    }
    await this.ctx.storage.deleteAll();
    this.game = newGame();
  }

  // ----- logika gry -----

  place(me, ships) {
    const g = this.game;
    const p = g.players[me];
    if (g.phase !== "setup") return "Gra już trwa.";
    if (p.ready) return "Statki są już rozstawione.";
    const valid = validateShips(ships);
    if (!valid) return "Nieprawidłowe ustawienie statków.";
    p.ships = valid;
    p.ready = true;
    this.maybeStart();
    return null;
  }

  unplace(me) {
    const g = this.game;
    const p = g.players[me];
    if (g.phase !== "setup") return "Gra już trwa.";
    p.ready = false;
    p.ships = [];
    return null;
  }

  maybeStart() {
    const g = this.game;
    if (g.phase === "setup" && g.players.length === 2 && g.players.every((p) => p.ready)) {
      g.phase = "playing";
      g.turn = Math.random() < 0.5 ? 0 : 1;
      g.last = null;
    }
  }

  fire(me, idx) {
    const g = this.game;
    if (g.phase !== "playing") return "Gra jeszcze się nie zaczęła.";
    if (g.turn !== me) return "To nie Twoja kolej.";
    if (!Number.isInteger(idx) || idx < 0 || idx >= CELLS) return "Nieprawidłowe pole.";
    const opp = g.players[1 - me];
    if (opp.incoming[idx]) return "W to pole już strzelałeś.";

    const ship = opp.ships.find((s) => s.cells.includes(idx));
    if (!ship) {
      opp.incoming[idx] = 1;
      g.last = { by: me, idx, res: "miss" };
      g.turn = 1 - me;
      return null;
    }
    opp.incoming[idx] = 2;
    const sunk = ship.cells.every((c) => opp.incoming[c] === 2);
    g.last = { by: me, idx, res: sunk ? "sunk" : "hit" };
    if (sunk) g.last.ship = SHIP_NAMES[ship.id];
    if (opp.ships.every((s) => s.cells.every((c) => opp.incoming[c] === 2))) {
      g.phase = "finished";
      g.winner = me;
    } else if (!g.rules.again) {
      g.turn = 1 - me;
    }
    return null;
  }

  rematch(me) {
    const g = this.game;
    if (g.phase !== "finished") return "Rewanż jest możliwy po zakończeniu gry.";
    g.players[me].rematch = true;
    if (g.players.length === 2 && g.players.every((p) => p.rematch)) {
      for (const p of g.players) {
        p.ships = [];
        p.ready = false;
        p.rematch = false;
        p.incoming = new Array(CELLS).fill(0);
      }
      g.phase = "setup";
      g.turn = null;
      g.winner = null;
      g.last = null;
    }
    return null;
  }

  // ----- widok dla gracza (bez ujawniania statków przeciwnika) -----

  isOnline(token) {
    return this.ctx.getWebSockets(token).some((w) => w.readyState === 1);
  }

  view(me) {
    const g = this.game;
    const P = g.players;
    const mine = P[me];
    const theirs = P[1 - me];
    const sunkOf = (pl) => pl.ships.filter((s) => s.cells.every((c) => pl.incoming[c] === 2));

    const v = {
      t: "state",
      you: me,
      phase: g.phase,
      rules: g.rules,
      names: [0, 1].map((i) => (P[i] ? P[i].name : null)),
      connected: [0, 1].map((i) => (P[i] ? this.isOnline(P[i].token) : false)),
      ready: [0, 1].map((i) => !!(P[i] && P[i].ready)),
      rematch: [0, 1].map((i) => !!(P[i] && P[i].rematch)),
      turn: g.turn,
      winner: g.winner,
      last: g.last,
      myShips: mine.ships.map((s) => ({
        id: s.id,
        name: SHIP_NAMES[s.id],
        cells: s.cells,
        sunk: s.cells.every((c) => mine.incoming[c] === 2),
      })),
      incoming: mine.incoming,
      outgoing: theirs ? theirs.incoming : new Array(CELLS).fill(0),
      sunkEnemy: theirs ? sunkOf(theirs).map((s) => ({ id: s.id, name: SHIP_NAMES[s.id], cells: s.cells })) : [],
    };
    if (g.phase === "finished" && theirs) {
      v.enemyShips = theirs.ships.map((s) => ({ id: s.id, name: SHIP_NAMES[s.id], cells: s.cells }));
    }
    return v;
  }

  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const att = ws.deserializeAttachment();
      if (!att || !this.game.players[att.idx]) continue;
      try {
        ws.send(JSON.stringify(this.view(att.idx)));
      } catch {}
    }
  }

  async save() {
    await this.ctx.storage.put("game", this.game);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }
}
