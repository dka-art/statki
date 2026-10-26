(() => {
  "use strict";

  const SIZE = 10;
  const CELLS = SIZE * SIZE;
  const LETTERS = "ABCDEFGHIJ";
  const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
  const FLEET = [
    { id: 0, name: "Lotniskowiec", len: 5 },
    { id: 1, name: "Pancernik", len: 4 },
    { id: 2, name: "Krążownik", len: 3 },
    { id: 3, name: "Okręt podwodny", len: 3 },
    { id: 4, name: "Niszczyciel", len: 2 },
  ];

  const $ = (sel) => document.querySelector(sel);
  const el = {
    lobby: $("#lobby"), fullBox: $("#fullBox"), game: $("#game"),
    roomInfo: $("#roomInfo"), roomCode: $("#roomCode"), copyBtn: $("#copyBtn"),
    nameInput: $("#nameInput"), againChk: $("#againChk"), newBtn: $("#newBtn"),
    joinForm: $("#joinForm"), codeInput: $("#codeInput"), lobbyErr: $("#lobbyErr"),
    inviteBox: $("#inviteBox"), inviteCode: $("#inviteCode"), joinLinkBtn: $("#joinLinkBtn"), newBox: $("#newBox"),
    connBanner: $("#connBanner"), plMe: $("#plMe"), plOpp: $("#plOpp"),
    statusMain: $("#statusMain"), statusSub: $("#statusSub"), rulesNote: $("#rulesNote"),
    setupPanel: $("#setupPanel"), waitPanel: $("#waitPanel"), endPanel: $("#endPanel"),
    dock: $("#dock"), rotBtn: $("#rotBtn"), randBtn: $("#randBtn"), clrBtn: $("#clrBtn"),
    readyBtn: $("#readyBtn"), unreadyBtn: $("#unreadyBtn"), rematchBtn: $("#rematchBtn"),
    boards: $("#boards"), myWrap: $("#myWrap"), enWrap: $("#enWrap"),
    myBoard: $("#myBoard"), enBoard: $("#enBoard"), myFleet: $("#myFleet"), enFleet: $("#enFleet"),
    toast: $("#toast"),
    chat: $("#chat"), chatToggle: $("#chatToggle"), chatBadge: $("#chatBadge"), chatLog: $("#chatLog"),
    chatQuick: $("#chatQuick"), chatForm: $("#chatForm"), chatInput: $("#chatInput"), chatSend: $("#chatSend"),
  };

  // ---------- stan ----------
  let code = null;
  let token = null;
  let myName = "";
  let ws = null;
  let state = null;
  let closedForGood = false;
  let reconnectTimer = null;
  let pingTimer = null;
  let reconnectDelay = 500;
  let toastTimer = null;
  const local = { ships: [], selected: 0, horiz: true, hover: null };
  let chatSeen = 0;      // znacznik czasu najnowszej przeczytanej wiadomości
  let chatKey = "";      // zapobiega przebudowie listy, gdy nic się nie zmieniło
  let unreadNow = 0;
  const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|️|‍|\s){1,6}$/u;

  // ---------- pomocnicze ----------
  function div(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }
  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch { return null; }
    return null;
  }
  function getToken(room) {
    const key = "statki:token:" + room;
    let t = store(key);
    if (!t) {
      t = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2));
      store(key, t);
    }
    return t;
  }
  function hasToken(room) { return !!store("statki:token:" + room); }
  function coord(i) { return LETTERS[i % SIZE] + (Math.floor(i / SIZE) + 1); }
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), 2800);
  }
  function showLobbyError(msg) {
    el.lobbyErr.textContent = msg;
    el.lobbyErr.hidden = !msg;
  }
  function readName() {
    const n = el.nameInput.value.trim().slice(0, 16);
    store("statki:name", n);
    return n;
  }
  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ---------- plansze (budowa DOM) ----------
  function buildBoard(root) {
    root.innerHTML = "";
    root.appendChild(div("lbl"));
    for (let c = 0; c < SIZE; c++) root.appendChild(div("lbl", LETTERS[c]));
    const cells = [];
    for (let r = 0; r < SIZE; r++) {
      root.appendChild(div("lbl", String(r + 1)));
      for (let c = 0; c < SIZE; c++) {
        const cell = div("cell");
        cell.dataset.i = String(r * SIZE + c);
        root.appendChild(cell);
        cells.push(cell);
      }
    }
    return cells;
  }
  el.myBoard.classList.add("mine");
  const myCells = buildBoard(el.myBoard);
  const enCells = buildBoard(el.enBoard);

  // mapa: pole -> klasy kadłuba
  function hullClasses(ships, base) {
    const map = new Map();
    for (const s of ships) {
      const cells = s.cells.slice().sort((a, b) => a - b);
      const horiz = cells[1] - cells[0] === 1;
      cells.forEach((c, k) => {
        const cl = [base, horiz ? "h" : "v"];
        if (k === 0) cl.push("bow");
        if (k === cells.length - 1) cl.push("stern");
        map.set(c, cl);
      });
    }
    return map;
  }

  // ---------- rozstawianie ----------
  function cellsFor(idx, len, horiz) {
    let r = Math.floor(idx / SIZE);
    let c = idx % SIZE;
    if (horiz) c = Math.min(c, SIZE - len); else r = Math.min(r, SIZE - len);
    const out = [];
    for (let k = 0; k < len; k++) out.push(horiz ? r * SIZE + c + k : (r + k) * SIZE + c);
    return out;
  }
  function occupied(exceptId) {
    const set = new Set();
    for (const s of local.ships) if (s.id !== exceptId) s.cells.forEach((c) => set.add(c));
    return set;
  }
  function nextUnplaced() {
    const f = FLEET.find((f) => !local.ships.some((s) => s.id === f.id));
    return f ? f.id : null;
  }
  function currentPreview() {
    if (local.hover === null || local.selected === null) return null;
    const f = FLEET[local.selected];
    const cells = cellsFor(local.hover, f.len, local.horiz);
    const occ = occupied();
    return { cells, ok: cells.every((c) => !occ.has(c)) };
  }
  function placeAt(idx) {
    if (local.selected === null) return;
    const f = FLEET[local.selected];
    const cells = cellsFor(idx, f.len, local.horiz);
    const occ = occupied();
    if (!cells.every((c) => !occ.has(c))) { toast("Tu statek się nie zmieści."); return; }
    local.ships.push({ id: f.id, cells });
    local.selected = nextUnplaced();
  }
  function randomize() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const ships = [];
      const occ = new Set();
      let okAll = true;
      for (const f of FLEET) {
        let placed = false;
        for (let t = 0; t < 300 && !placed; t++) {
          const horiz = Math.random() < 0.5;
          const r = Math.floor(Math.random() * (horiz ? SIZE : SIZE - f.len + 1));
          const c = Math.floor(Math.random() * (horiz ? SIZE - f.len + 1 : SIZE));
          const cells = [];
          for (let k = 0; k < f.len; k++) cells.push(horiz ? r * SIZE + c + k : (r + k) * SIZE + c);
          if (cells.every((x) => !occ.has(x))) {
            cells.forEach((x) => occ.add(x));
            ships.push({ id: f.id, cells });
            placed = true;
          }
        }
        if (!placed) { okAll = false; break; }
      }
      if (okAll) { local.ships = ships; local.selected = null; return; }
    }
  }

  function renderDock() {
    el.dock.innerHTML = "";
    for (const f of FLEET) {
      const placed = local.ships.some((s) => s.id === f.id);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "shipChip" + (placed ? " placed" : "") + (!placed && local.selected === f.id ? " sel" : "");
      const pips = document.createElement("span");
      pips.className = "pips";
      for (let k = 0; k < f.len; k++) pips.appendChild(document.createElement("i"));
      const label = document.createElement("span");
      label.textContent = f.name;
      b.append(pips, label);
      b.addEventListener("click", () => {
        if (placed) return;
        local.selected = f.id;
        render();
      });
      el.dock.appendChild(b);
    }
    el.readyBtn.disabled = local.ships.length !== FLEET.length;
  }

  // ---------- rysowanie ----------
  function inSetup() {
    return state && state.phase === "setup" && !state.ready[state.you];
  }

  function renderMyBoard() {
    const editing = inSetup();
    el.myBoard.classList.toggle("editing", editing);
    const ships = editing ? local.ships : state.myShips;
    const hull = hullClasses(ships, "ship");
    const sunkCells = new Set(editing ? [] : state.myShips.filter((s) => s.sunk).flatMap((s) => s.cells));
    const prev = editing ? currentPreview() : null;
    const pvHull = prev ? hullClasses([{ cells: prev.cells }], "pv") : new Map();

    for (let i = 0; i < CELLS; i++) {
      const cls = ["cell"];
      if (hull.has(i)) cls.push(...hull.get(i));
      if (sunkCells.has(i)) cls.push("sunk");
      if (!editing) {
        const v = state.incoming[i];
        if (v === 1) cls.push("miss");
        if (v === 2) cls.push("hit");
        if (state.last && state.last.by !== state.you && state.last.idx === i) cls.push("last");
      }
      if (pvHull.has(i)) cls.push(...pvHull.get(i), prev.ok ? "pv-ok" : "pv-bad");
      myCells[i].className = cls.join(" ");
    }
  }

  function renderEnemyBoard() {
    const sunkHull = hullClasses(state.sunkEnemy || [], "ship");
    const revealHull = hullClasses(state.enemyShips || [], "ship");
    const myTurn = state.phase === "playing" && state.turn === state.you;
    for (let i = 0; i < CELLS; i++) {
      const cls = ["cell"];
      if (sunkHull.has(i)) cls.push(...sunkHull.get(i), "sunk");
      else if (revealHull.has(i)) cls.push(...revealHull.get(i), "reveal");
      const v = state.outgoing[i];
      if (v === 1) cls.push("miss");
      if (v === 2) cls.push("hit");
      if (myTurn && v === 0) cls.push("can");
      if (state.last && state.last.by === state.you && state.last.idx === i) cls.push("last");
      enCells[i].className = cls.join(" ");
    }
  }

  function chip(name, len, sunk) {
    const c = div("fchip" + (sunk ? " sunk" : ""));
    const i = document.createElement("i");
    c.append(i, document.createTextNode(`${name} (${len})`));
    return c;
  }
  function renderFleets() {
    el.myFleet.innerHTML = "";
    el.enFleet.innerHTML = "";
    for (const s of state.myShips) el.myFleet.appendChild(chip(s.name, s.cells.length, s.sunk));
    const sunkIds = new Set((state.sunkEnemy || []).map((s) => s.id));
    for (const f of FLEET) el.enFleet.appendChild(chip(f.name, f.len, sunkIds.has(f.id)));
  }

  function lastText() {
    const L = state.last;
    if (!L) return "";
    const opp = state.names[1 - state.you] || "Przeciwnik";
    const who = L.by === state.you ? "Ty" : opp;
    const what = L.res === "miss" ? "pudło" : L.res === "hit" ? "trafiony!" : `zatopiony: ${L.ship}!`;
    return `${who} → ${coord(L.idx)}: ${what}`;
  }

  function pill(node, name, tag, online, isTurn) {
    node.innerHTML = "";
    const dot = div("dot" + (online ? " on" : ""));
    const label = document.createElement("span");
    label.textContent = name;
    node.append(dot, label);
    if (tag) node.appendChild(div("tag", tag));
    node.classList.toggle("turn", !!isTurn);
  }

  function renderStatus() {
    const me = state.you;
    const opp = 1 - me;
    const oppHere = state.names[opp] !== null;
    const oppName = state.names[opp] || "Przeciwnik";
    let main = "", sub = "", tone = "";
    const playing = state.phase === "playing";

    if (state.phase === "setup") {
      if (!state.ready[me]) {
        main = "Rozstaw swoje statki";
        sub = oppHere
          ? `${oppName} jest w grze${state.ready[opp] ? " i już jest gotowy" : ""}.`
          : "Przeciwnik jeszcze nie dołączył — wyślij mu link do gry.";
      } else if (!oppHere) {
        main = "Czekam na przeciwnika…";
        sub = `Wyślij mu link (przycisk u góry) lub kod ${code}.`;
      } else {
        main = `Czekam aż ${oppName} rozstawi statki…`;
        sub = "Możesz jeszcze zmienić ustawienie swoich statków.";
      }
    } else if (playing) {
      if (state.turn === me) { main = "Twoja kolej!"; tone = "me"; sub = lastText() || "Kliknij pole na planszy przeciwnika."; }
      else { main = `Strzela ${oppName}…`; sub = lastText(); }
    } else {
      if (state.winner === me) { main = "Wygrałeś! 🎉"; tone = "win"; sub = "Cała flota przeciwnika poszła na dno."; }
      else { main = `${oppName} wygrywa`; tone = "lose"; sub = "Tym razem się nie udało — rewanż?"; }
    }

    el.statusMain.textContent = main;
    el.statusMain.className = "statusMain" + (tone ? " " + tone : "");
    el.statusSub.textContent = sub;
    el.rulesNote.textContent = state.rules.again ? "Zasada: po trafieniu strzelasz ponownie." : "Zasada: strzały na zmianę.";

    const meTag = state.phase === "setup" && state.ready[me] ? "gotowy" : "";
    pill(el.plMe, `Ty · ${state.names[me]}`, meTag, true, playing && state.turn === me);
    if (oppHere) {
      let tag = "";
      if (!state.connected[opp]) tag = "rozłączony";
      else if (state.phase === "setup") tag = state.ready[opp] ? "gotowy" : "rozstawia";
      pill(el.plOpp, state.names[opp], tag, state.connected[opp], playing && state.turn === opp);
    } else {
      pill(el.plOpp, "czekam na gracza…", "", false, false);
    }
  }

  // ---------- czat ----------
  function updateTitle() {
    const base = code ? `Statki · ${code}` : "Statki – gra online";
    document.title = (document.hidden && unreadNow > 0 ? `(${unreadNow}) ` : "") + base;
  }

  function renderChat() {
    const msgs = state.chat || [];
    const me = state.you;
    const hasOpp = state.names[1 - me] !== null;

    el.chatInput.disabled = !hasOpp;
    el.chatSend.disabled = !hasOpp;
    el.chatQuick.querySelectorAll("button").forEach((b) => (b.disabled = !hasOpp));
    el.chatInput.placeholder = hasOpp ? "Napisz wiadomość…" : "Czat włączy się, gdy dołączy przeciwnik";

    const newest = msgs.length ? msgs[msgs.length - 1].ts : 0;
    if (newest < chatSeen) chatSeen = 0; // czat został wyczyszczony (rewanż)

    const key = `${hasOpp}:${msgs.length}:${newest}`;
    if (key !== chatKey) {
      chatKey = key;
      const log = el.chatLog;
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.innerHTML = "";
      if (!msgs.length) {
        log.appendChild(div("chatEmpty", hasOpp ? "Brak wiadomości — przywitaj się 👋" : "Czat włączy się, gdy dołączy przeciwnik."));
      }
      for (const m of msgs) {
        const bubble = div("msg " + (m.by === me ? "me" : "them") + (EMOJI_ONLY.test(m.text) ? " emoji" : ""));
        bubble.appendChild(document.createTextNode(m.text)); // textContent — bez wstrzykiwania HTML
        const t = document.createElement("span");
        t.className = "time";
        t.textContent = new Date(m.ts).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
        bubble.appendChild(t);
        log.appendChild(bubble);
      }
      if (atBottom || (msgs.length && msgs[msgs.length - 1].by === me)) log.scrollTop = log.scrollHeight;
    }

    const open = !el.chat.classList.contains("collapsed");
    if (open && !document.hidden) chatSeen = newest;
    unreadNow = msgs.filter((m) => m.by !== me && m.ts > chatSeen).length;
    el.chatBadge.textContent = String(unreadNow);
    el.chatBadge.hidden = open || unreadNow === 0;
    updateTitle();
  }

  el.chatToggle.addEventListener("click", () => {
    const collapsed = el.chat.classList.toggle("collapsed");
    el.chatToggle.setAttribute("aria-expanded", String(!collapsed));
    if (state) renderChat();
    if (!collapsed) el.chatLog.scrollTop = el.chatLog.scrollHeight;
  });
  el.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    send({ t: "chat", text });
    el.chatInput.value = "";
  });
  el.chatQuick.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-q]");
    if (b && !b.disabled) send({ t: "chat", text: b.dataset.q });
  });
  document.addEventListener("visibilitychange", () => { if (state) renderChat(); else updateTitle(); });
  // na telefonie czat startuje zwinięty, żeby nie spychał plansz
  if (window.matchMedia("(max-width: 760px)").matches) {
    el.chat.classList.add("collapsed");
    el.chatToggle.setAttribute("aria-expanded", "false");
  }

  function render() {
    if (!state) return;
    const me = state.you;
    const setup = inSetup();

    el.setupPanel.hidden = !setup;
    el.waitPanel.hidden = !(state.phase === "setup" && state.ready[me]);
    el.endPanel.hidden = state.phase !== "finished";
    el.enWrap.hidden = state.phase === "setup";
    el.boards.classList.toggle("single", state.phase === "setup");
    el.myFleet.hidden = state.phase === "setup";
    el.enTitle = el.enTitle || $("#enTitle");
    const oppName = state.names[1 - me];
    el.enTitle.textContent = oppName ? `Plansza: ${oppName}` : "Plansza przeciwnika";

    renderStatus();
    if (setup) renderDock();
    renderMyBoard();
    if (state.phase !== "setup") { renderEnemyBoard(); renderFleets(); }
    renderChat();

    if (state.phase === "finished") {
      const opp = 1 - me;
      if (state.rematch[me]) { el.rematchBtn.textContent = "Czekam na rewanż…"; el.rematchBtn.disabled = true; }
      else if (state.rematch[opp]) { el.rematchBtn.textContent = `${state.names[opp]} chce rewanż — zagraj!`; el.rematchBtn.disabled = false; }
      else { el.rematchBtn.textContent = "Zagraj ponownie"; el.rematchBtn.disabled = false; }
    }
  }

  // ---------- połączenie ----------
  function connect() {
    clearTimeout(reconnectTimer);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/api/ws/${code}?token=${encodeURIComponent(token)}&name=${encodeURIComponent(myName)}`;
    ws = new WebSocket(url);
    ws.onopen = () => {
      reconnectDelay = 500;
      el.connBanner.hidden = true;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send("ping"); }, 20000);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "state") {
        const prev = state;
        state = m;
        if (prev && prev.phase === "finished" && m.phase === "setup") { local.ships = []; local.selected = 0; local.hover = null; }
        render();
      } else if (m.t === "full") {
        closedForGood = true;
        showFull();
      } else if (m.t === "error") {
        toast(m.msg || "Coś poszło nie tak.");
      }
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (closedForGood) return;
      el.connBanner.hidden = false;
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.7, 8000);
    };
  }

  function showFull() {
    el.game.hidden = true;
    el.lobby.hidden = true;
    el.roomInfo.hidden = true;
    el.fullBox.hidden = false;
  }

  function enterRoom(room) {
    code = room;
    token = getToken(room);
    myName = el.nameInput.value.trim().slice(0, 16);
    closedForGood = false;
    state = null;
    local.ships = []; local.selected = 0; local.hover = null; local.horiz = true;
    history.replaceState(null, "", "?pokoj=" + room);
    el.lobby.hidden = true;
    el.fullBox.hidden = true;
    el.game.hidden = false;
    el.roomInfo.hidden = false;
    el.roomCode.textContent = room;
    chatSeen = 0; chatKey = ""; unreadNow = 0;
    updateTitle();
    connect();
  }

  // ---------- lobby ----------
  async function createGame() {
    showLobbyError("");
    readName();
    el.newBtn.disabled = true;
    try {
      const res = await fetch("/api/new", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ again: el.againChk.checked }),
      });
      if (!res.ok) throw new Error("http " + res.status);
      const data = await res.json();
      enterRoom(data.code);
    } catch {
      showLobbyError("Nie udało się założyć gry. Spróbuj ponownie za chwilę.");
    } finally {
      el.newBtn.disabled = false;
    }
  }

  el.newBtn.addEventListener("click", createGame);
  el.joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const c = el.codeInput.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "");
    if (!CODE_RE.test(c)) { showLobbyError("Kod gry ma 6 znaków, np. K7P2QX."); return; }
    showLobbyError("");
    readName();
    enterRoom(c);
  });
  el.codeInput.addEventListener("input", () => {
    el.codeInput.value = el.codeInput.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "");
  });
  el.joinLinkBtn.addEventListener("click", () => {
    const c = el.inviteCode.textContent;
    readName();
    enterRoom(c);
  });

  // ---------- kopiowanie linku ----------
  el.copyBtn.addEventListener("click", async () => {
    const link = `${location.origin}/?pokoj=${code}`;
    let ok = false;
    try { await navigator.clipboard.writeText(link); ok = true; } catch {
      const ta = document.createElement("textarea");
      ta.value = link; document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch {}
      ta.remove();
    }
    el.copyBtn.textContent = ok ? "Skopiowano ✓" : "Skopiuj ręcznie";
    if (!ok) toast(link);
    setTimeout(() => (el.copyBtn.textContent = "Kopiuj link"), 1800);
  });

  // ---------- interakcje na planszach ----------
  function cellIndex(target) {
    const c = target.closest && target.closest(".cell");
    return c ? Number(c.dataset.i) : null;
  }

  el.myBoard.addEventListener("mouseover", (e) => {
    if (!inSetup()) return;
    const i = cellIndex(e.target);
    if (i === null || i === local.hover) return;
    local.hover = i;
    renderMyBoard();
  });
  el.myBoard.addEventListener("mouseleave", () => {
    if (!inSetup() || local.hover === null) return;
    local.hover = null;
    renderMyBoard();
  });
  el.myBoard.addEventListener("contextmenu", (e) => {
    if (!inSetup()) return;
    e.preventDefault();
    local.horiz = !local.horiz;
    renderMyBoard();
  });
  el.myBoard.addEventListener("click", (e) => {
    if (!inSetup()) return;
    const i = cellIndex(e.target);
    if (i === null) return;
    const hit = local.ships.find((s) => s.cells.includes(i));
    if (hit) {
      local.ships = local.ships.filter((s) => s !== hit);
      local.selected = hit.id;
      local.horiz = hit.cells[1] - hit.cells[0] === 1;
    } else {
      placeAt(i);
    }
    local.hover = null;
    render();
  });

  el.enBoard.addEventListener("click", (e) => {
    if (!state || state.phase !== "playing") return;
    const i = cellIndex(e.target);
    if (i === null) return;
    if (state.turn !== state.you) { toast("To nie Twoja kolej."); return; }
    if (state.outgoing[i] !== 0) { toast("W to pole już strzelałeś."); return; }
    send({ t: "fire", idx: i });
  });

  el.rotBtn.addEventListener("click", () => { local.horiz = !local.horiz; renderMyBoard(); });
  el.randBtn.addEventListener("click", () => { randomize(); render(); });
  el.clrBtn.addEventListener("click", () => { local.ships = []; local.selected = 0; render(); });
  el.readyBtn.addEventListener("click", () => {
    if (local.ships.length !== FLEET.length) return;
    send({ t: "place", ships: local.ships });
  });
  el.unreadyBtn.addEventListener("click", () => send({ t: "unplace" }));
  el.rematchBtn.addEventListener("click", () => send({ t: "rematch" }));
  document.addEventListener("keydown", (e) => {
    if ((e.key === "r" || e.key === "R") && inSetup() && document.activeElement.tagName !== "INPUT") {
      local.horiz = !local.horiz;
      renderMyBoard();
    }
  });

  // ---------- start ----------
  el.nameInput.value = store("statki:name") || "";
  const param = (new URLSearchParams(location.search).get("pokoj") || "").toUpperCase();
  if (CODE_RE.test(param)) {
    if (hasToken(param)) {
      // wracający gracz — wchodzimy od razu
      enterRoom(param);
    } else {
      el.inviteCode.textContent = param;
      el.inviteBox.hidden = false;
      el.newBox.hidden = true;
    }
  }
})();
