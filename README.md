# Vaječný Deník

Evidence snášky a prodeje vajec pro azyl **Nech mě růst**. Single-page aplikace, frontend čistě v HTML/JS s Tailwind CSS přes CDN, perzistence v `localStorage`, volitelná cloud záloha přes Vercel KV (Upstash Redis).

## Funkce

- Denní evidence sněsených a prodaných vajec (3 kategorie: slepičí M/V, zelená M/V, křepelčí)
- Automatický výpočet zůstatků skladu, denní tržby a celkové hodnoty
- Filtrování podle měsíců (generováno dynamicky z dat)
- Editace, mazání, fulltext na datum
- Detekce záporných zůstatků s povinným potvrzením
- Export do CSV (kompatibilní s Excelem, BOM pro diakritiku)
- Export/import celé databáze do/z JSON
- Cloud sync (debounced 3s po každé změně) přes Vercel KV
- Migrace starých dat z verze v3 (původní pojmenování `colM`, `colKc` atd.)

## Architektura

```
.
├── index.html        # frontend (statika)
├── app.js            # veškerá business logika
├── api/
│   └── data.js       # serverless function (GET/POST do KV)
├── package.json      # Vercel závislosti
├── .env.example      # šablona env proměnných
└── .gitignore
```

Toky dat:

- **Primární uložiště:** `localStorage` v prohlížeči. Aplikace funguje 100 % offline.
- **Cloud záloha:** po každé změně se po 3s zpoždění odešle celý JSON do Vercel KV. Při startu aplikace lze ručně stáhnout zálohu z cloudu.
- **Lokální záloha:** kdykoli lze stáhnout celou databázi jako JSON soubor.

## Deploy na Vercel

### 1. Připrav repo

```bash
git init
git add .
git commit -m "init"
git remote add origin git@github.com:tvuj-username/vajecny-denik.git
git push -u origin main
```

### 2. Napoj projekt na Vercel

- [vercel.com](https://vercel.com) → **Add New Project** → vyber repo → **Deploy**.
- Vercel automaticky detekuje statiku + serverless funkci v `/api`.

### 3. Připoj KV storage

- V projektu na Vercel: **Storage** → **Create Database** → vyber **KV (Upstash Redis)**.
- Pojmenuj např. `vajecny-denik-kv`, vyber region (Frankfurt/Stockholm pro EU).
- Vercel automaticky doplní env proměnné `KV_*` do projektu.

### 4. Nastav přístupový klíč

V **Project Settings → Environment Variables** přidej:

```
ACCESS_KEY = <vygenerovaný náhodný řetězec>
```

Doporučená délka: 32+ znaků. Vygenerovat můžeš třeba:

```bash
openssl rand -hex 24
```

Po přidání proměnné spusť **Redeploy** v dashboardu (jinak se proměnná nepropíše).

### 5. Aktivuj cloud sync v aplikaci

Otevři nasazenou aplikaci → **Nastavení** → vlož stejný `ACCESS_KEY` do pole *Přístupový klíč* → **Uložit nastavení**.

Od té chvíle se každá změna automaticky synchronizuje. Indikátor v hlavičce ukazuje stav (`offline`, `syncing…`, `synced`, `sync error`).

## Lokální vývoj

```bash
npm install -g vercel
vercel login
vercel link            # napojí lokální složku na projekt
vercel env pull        # stáhne env proměnné lokálně
vercel dev             # spustí na http://localhost:3000
```

Pokud nechceš řešit KV při vývoji, můžeš app otevřít jen statickým serverem (`python -m http.server`). Cloud sync prostě nebude fungovat — aplikace funguje normálně přes `localStorage`.

## Limity free plánu

Vercel Hobby + KV (Upstash):

- **30 000 KV commands/den** — při typickém použití (zápis pár krát denně) je to víc než dost
- **256 MB storage** — celá databáze v JSON má řádově kilobyty
- **100 GB bandwidth/měsíc** — pro privátní aplikaci nepřekonatelné
- **100k serverless invocations/měsíc** — limit, ke kterému se reálně nepřiblížíš

## Bezpečnost

Aplikace používá jednoduchý sdílený tajný klíč pro autorizaci API požadavků. Pro osobní/interní use case je to dostatečné. Pokud bys chtěl víceuživatelský přístup, je potřeba přidat skutečnou autentikaci (např. Clerk, Auth.js, nebo magic link).

**Neukládej `ACCESS_KEY` do gitu.** Slouží k tomu env proměnné na Vercel + lokální `.env.local` (oba jsou v `.gitignore`).

## Backup strategie (doporučená)

1. **Primární:** automatický cloud sync (Vercel KV) — zachytí každou drobnou změnu.
2. **Sekundární:** jednou týdně/měsíčně si stáhni JSON přes **Nastavení → Exportovat JSON** a ulož mimo cloud (Drive, lokální disk).
3. **Tisk pro účetnictví:** CSV export do Excelu.

## Migrace ze staré verze

Aplikace umí přečíst data z původní verze (`egg_tracker_v3_data` v localStorage) a automaticky je migruje na nové schéma. Stačí otevřít nasazenou aplikaci v tom samém prohlížeči, kde běžela ta původní.

## Plány do budoucna

- Grafy snášky a tržeb po měsících
- Auto-pull z cloudu při startu, pokud je cloud verze novější než lokální
- PWA + offline service worker (přidávat data v terénu bez signálu)
- Build pipeline pro Tailwind (eliminuje warning z CDN v konzoli)

## Veřejné API pro prodejní web

Vedle privátního `/api/data` (owner sync) jsou tři veřejné endpointy pro prodejní web *Čerstvě sneseno*:

### `GET /api/stock`

Bez autorizace. Vrací aktuální dostupný sklad (fyzický stav minus aktivní rezervace).

```bash
curl https://vajecnydenik.vercel.app/api/stock
```

```json
{
  "available": { "slepM": 3, "slepV": 53, "zelM": 4, "zelV": 0, "krep": 81 },
  "physical":  { "slepM": 3, "slepV": 53, "zelM": 4, "zelV": 0, "krep": 81 },
  "reserved":  { "slepM": 0, "slepV": 0,  "zelM": 0, "zelV": 0, "krep": 0 },
  "updatedAt": "2026-05-28T05:54:17.000Z",
  "prices":    { "slepM": 5, "slepV": 6, "zelM": 7, "zelV": 7, "krep": 3 }
}
```

Edge cache: 30 s + SWR 60 s.

### `POST /api/reserve`

Bez autorizace. Vytvoří rezervaci s TTL **4 hodiny**. Rate-limit 5 rezervací/IP/h.

```bash
curl -X POST https://vajecnydenik.vercel.app/api/reserve \
  -H 'Content-Type: application/json' \
  -d '{
    "items": { "slepV": 10, "krep": 6 },
    "customer": { "name": "Jan Novák", "phone": "+420123456789" }
  }'
```

Při nedostatku skladu → `409` se shrnutím nedostupných položek. Validace selže → `400`.

### `GET /api/reservations/<id>`

Bez autorizace. Vrací stav rezervace (pro status stránku zákazníka).

### Owner endpoints (vyžadují `?key=<ACCESS_KEY>`)

- `GET /api/reservations` — list všech aktivních rezervací (pro UI deníku).
- `DELETE /api/reservations/<id>` — zrušit / potvrdit rezervaci.

### CORS

Stock je `*`. Reserve a reservations používají `WEB_ORIGIN` z env. Pro vývoj nastav `WEB_ORIGIN=http://localhost:3000`.
