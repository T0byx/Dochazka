# Moje Docházka – pokyny pro Claude Code

Webová appka (PWA) pro evidenci docházky. Používá ji jedna osoba (mamka) v telefonu a na jejích
datech záleží. **Ochrana dat má přednost před vším ostatním.**

## Jak je to poskládané

- `index.html` – celá appka (HTML + JS, bez buildu). GitHub Pages ji servíruje z větve `main`,
  takže **co je v `main`, to má mamka v telefonu**. Repozitář je **veřejný**.
- `sw.js` – service worker (offline režim + push). Po každé změně zvyš konstantu `CACHE`.
- Firebase projekt `evidence-dochazky`: Authentication (e-mail + heslo) a Firestore:
  - `dochazka/entries` – VŠECHNA data jako text JSON v poli `json` (`{ entries, settings }`),
    dále `updatedAt` (číslo) a `prevHistoryId` (odkaz na předchozí verzi v historii).
  - `dochazka/entries/history/{id}` – předchozí verze dat (`json`, `savedAt`, `reason`), jen přidávat.
  - `dochazka/push` – telefony pro upozornění (`tokens`, `lastNotifiedDate` zapisuje Worker).
- `firestore.rules` – pravidla databáze, vlastník = UID ve funkci `ownerUids()`. Nasazuje je člověk ručně.
- `worker/dochazka-notify.js` – Cloudflare Worker (cron každou minutu): upozornění na konec směny
  a denní záloha do KV `BACKUPS`. Nasazuje se ručně v Cloudflare. Používá službový účet
  (na ten se pravidla databáze nevztahují).
- `tests/` – testy proti lokálním emulátorům (projekt `demo-dochazka`), nikdy proti produkci.
- `ZABEZPECENI.md` – co musí udělat člověk v konzolích a jak obnovit data.

## Pravidla ochrany dat (vždy dodržet)

1. Do databáze zapisuj jen přes `commit()`, `updateDay()` nebo `updateSettings()` v `index.html`.
   Nikdy přímo `docRef.set/update/delete`. Každá změna musí být transakce nad čerstvými daty
   ze serveru a musí uložit předchozí verzi do historie (pravidla databáze to vynucují).
2. Dokud `dataReady` není `true`, nic neukládej. Dřív offline start přepsal všechna data prázdnými.
3. Text z databáze vkládej do HTML jen přes `esc()`. Žádné inline `onclick="…"` s daty –
   použij `data-*` atribut a `addEventListener` (kontroluje `npm run check`).
4. Nikdy nespouštěj nic proti produkci (Firebase `evidence-dochazky`, Cloudflare): žádný deploy,
   mazání, import ani zápis přes API bez výslovného souhlasu člověka. Hlídá to
   `.claude/hooks/guard-bash.mjs`.
5. Repozitář je veřejný: nikdy necommituj klíče, službový účet (JSON), hesla ani data docházky.
6. Pravidla databáze povolují jen vlastníka, zakazují mazání, vyžadují archivaci předchozí verze
   a odmítnou zmenšení dat o víc než 2000 znaků jedním zápisem. Když měníš formát dat nebo
   způsob ukládání, uprav pravidla i testy zároveň.
7. Pořadí nasazení: nejdřív appka (merge do `main`), mamka appku zavře a znovu otevře,
   teprve potom nová pravidla. Nová pravidla odmítají zápisy staré verze appky.

## Příkazy

- `npm install` – nástroje pro testy (emulátor Firestore potřebuje Javu 21)
- `npm run check` – syntaxe, inline handlery, tajemství (spouští se i automaticky po úpravě souboru)
- `npm test` – všechno: check, pojistky, Worker, pravidla, appka v prohlížeči
- `npm run test:rules`, `npm run test:e2e`, `npm run test:worker`, `npm run test:hooks` – jednotlivě
- Prostředí bez přístupu k CDN: `LOCAL_CDN_DIR=… npm run test:e2e` (viz hlavička `tests/app.e2e.test.mjs`)

## Obnova dat

Viz `ZABEZPECENI.md`: historie v appce (Nastavení → Historie změn), Firebase konzole,
denní zálohy v Cloudflare KV, soubor ze „Stáhnout zálohu“.
