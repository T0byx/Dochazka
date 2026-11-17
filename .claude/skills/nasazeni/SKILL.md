---
name: nasazeni
description: Bezpečné nasazení změn Docházky do produkce – appka (merge do main), pravidla databáze (firestore.rules) a Cloudflare Worker – ve správném pořadí a s kontrolami. Spouští jen člověk příkazem /nasazeni.
disable-model-invocation: true
---

# Nasazení Docházky

Projdi kroky v tomto pořadí a u každého řekni, co jsi zjistil. **Sám nic nenasazuj ani nezapisuj
do produkce** – nasazení dělá člověk (Bash i MCP pojistky se u nasazení ptají, mazání blokují).

## 1. Stav repozitáře a testy

1. `git status` a `git log --oneline -5` – pracovní strom musí být čistý, změny commitnuté.
2. `npm test` – musí projít všechno (check, pojistky, Worker, pravidla, appka v prohlížeči).
   Bez přístupu k CDN použij `LOCAL_CDN_DIR` (viz hlavička `tests/app.e2e.test.mjs`).
3. Zjisti, co se od `origin/main` změnilo (`git diff --stat origin/main...HEAD`) a rozděl to na:
   - **appka**: `index.html`, `sw.js`, `manifest.json`, ikony → nasadí se merge do `main` (GitHub Pages),
   - **pravidla**: `firestore.rules` → ručně ve Firebase,
   - **Worker**: `worker/dochazka-notify.js` → ručně v Cloudflare.
4. Když se změnil `sw.js`, ověř, že je zvýšená konstanta `CACHE`.
5. U změn ukládání, pravidel, sw.js nebo Workeru spusť subagenta `data-safety-reviewer`.

## 2. Appka (vždy první)

1. Změny jdou do `main` jen přes pull request se zelenou kontrolou „Kontroly a testy“.
2. Po merge: GitHub Pages zveřejní novou verzi do pár minut. Mamka musí appku úplně zavřít
   a znovu otevřít, jinak jí v telefonu běží stará verze.

## 3. Pravidla databáze (až po appce)

1. V `firestore.rules` nesmí zůstat `DOPLN_UID` – funkce `ownerUids()` musí obsahovat UID mamčina účtu
   (najdeš ho přes `auth_get_users` v read-only Firebase MCP nebo v konzoli Authentication → Users).
2. Když je k dispozici Firebase MCP (`firebase-readonly`): načti produkční pravidla
   (`firebase_get_security_rules`, typ firestore), ukaž rozdíl proti `firestore.rules`
   a ověř syntaxi (`firebase_validate_security_rules`).
3. Ověř pořadí: verze appky v `main` už ukládá historii (v `index.html` na `origin/main` je `prevHistoryId`)
   a mamka appku po nasazení znovu otevřela. Nová pravidla zápisy staré verze odmítnou.
4. Nasazení provede člověk: Firebase konzole → Firestore Database → Rules → vložit → Publish,
   nebo `npx firebase deploy --only firestore:rules --project evidence-dochazky` (pojistka se zeptá).
5. Ověření: po další změně v appce vznikne dokument v `dochazka/entries/history`
   (`firestore_list_documents` v read-only MCP) a v appce v Nastavení → Historie změn je nová verze.

## 4. Cloudflare Worker

1. Porovnej `worker/dochazka-notify.js` s nasazeným kódem (Cloudflare MCP `workers_get_worker_code`
   pro `dochazka-notify`) a ukaž rozdíl.
2. Nasazení provede člověk: Workers & Pages → `dochazka-notify` → Edit code → vložit → Deploy.
   Worker musí mít binding `BACKUPS` na KV namespace `dochazka-zalohy` (Settings → Bindings).
3. Ověření dělá člověk: `https://dochazka-notify.<subdoména>.workers.dev/backup-now?key=<ADMIN_KEY>`
   vrátí „Záloha rucni-… uložena (N záznamů)“.

## 5. Shrnutí

Napiš, co bylo nasazeno, co zbývá (např. čeká se na znovuotevření appky u mamky) a jak to ověřit.
