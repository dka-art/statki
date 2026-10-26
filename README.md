# Statki online (1 na 1)

Klasyczna gra w statki dla dwóch osób, działająca w przeglądarce (komputer, tablet, telefon).
Hostowana na **Cloudflare Workers** (serwer + strona w jednym), kod w **GitHubie**.

## Jak to działa

- Jeden pokój = jedna gra dla dwóch osób. Wiele pokoi może działać równolegle.
- Założenie gry daje 6-znakowy kod (np. `K7P2QX`) i link `https://twoja-domena/?pokoj=K7P2QX`.
  Wysyłasz link (lub sam kod) znajomemu — to całe „uwierzytelnienie”.
- Przeglądarka zapamiętuje Twoje miejsce w pokoju, więc odświeżenie strony lub chwilowy brak
  internetu nie wyrzuca z gry.
- Serwer pilnuje zasad i **nie ujawnia pozycji statków przeciwnika** — nie da się ich podejrzeć.
- Zasady: plansza 10×10, flota 5 + 4 + 3 + 3 + 2 pól, statki mogą się stykać.
  Przy zakładaniu gry wybierasz, czy po trafieniu strzelasz ponownie (jak w papierowej wersji),
  czy strzały idą na zmianę.
- Pusty pokój znika po 24 godzinach bez aktywności.

## Struktura projektu

```
statki/
├── public/            strona: index.html, style.css, app.js
├── src/index.js       serwer: Worker + Durable Object (logika gry, WebSocket)
├── wrangler.jsonc     konfiguracja Cloudflare
├── package.json
└── README.md
```

## Wdrożenie krok po kroku (GitHub + Cloudflare)

### 1. GitHub
1. Rozpakuj ZIP na komputerze.
2. Na github.com kliknij **New repository**, nazwij go np. `statki`, kliknij **Create repository**.
3. Na stronie nowego repozytorium wybierz **uploading an existing file**.
4. Przeciągnij do okna **zawartość** rozpakowanego folderu (foldery `public` i `src` oraz pliki
   `wrangler.jsonc`, `package.json`, `package-lock.json`, `.gitignore`, `README.md`) — nie sam ZIP.
5. Kliknij **Commit changes**.

### 2. Cloudflare
1. Zaloguj się na dash.cloudflare.com i wejdź w **Workers & Pages**.
2. Kliknij **Create application** → **Import a repository** (połączenie z GitHubem; przy pierwszym
   razie zezwól Cloudflare na dostęp do repozytorium `statki`).
3. Wybierz repozytorium `statki`.
4. Nazwa projektu musi być taka sama jak `name` w `wrangler.jsonc` (domyślnie `statki`).
   Jeśli chcesz inną nazwę, zmień ją w obu miejscach.
5. Build command zostaw puste, a **Deploy command**: `npx wrangler deploy`.
6. Kliknij **Save and Deploy**. Po minucie gra jest pod adresem w stylu
   `https://statki.TWOJA-NAZWA.workers.dev`.

Każda kolejna zmiana wrzucona do GitHuba wdroży się automatycznie.

Własną domenę dodasz później w ustawieniach Workera: **Settings → Domains & Routes**.

> Durable Objects działają na darmowym koncie Cloudflare (z limitami, które przy takiej grze
> raczej nie zostaną przekroczone). Konfiguracja używa wariantu SQLite, który jest do tego wymagany.

## Uruchomienie lokalne (opcjonalnie)

Potrzebny jest Node.js 20 lub nowszy.

```
npm install
npm run dev
```

Gra będzie pod `http://localhost:8787`. Żeby zagrać samemu ze sobą, otwórz drugą grę w oknie
incognito (każda przeglądarka ma własne „miejsce” w pokoju).

## Wdrożenie z komputera (zamiast panelu Cloudflare)

```
npm install
npx wrangler login
npx wrangler deploy
```

## Pomysły na rozbudowę

- wersja dla 3–4 graczy,
- czat lub emotki w trakcie gry,
- zapisywanie wyników, dźwięki, animacje zatopienia,
- własna domena i krótki link do zaproszeń.
