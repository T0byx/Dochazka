# Zabezpečení a zálohy docházky

Kontrola proběhla 17. 11. 2026. Kód v této větvi je hotový a otestovaný. Níže jsou kroky, které je
potřeba udělat ručně v konzolích Firebase, Google Cloud a Cloudflare (Claude k nim nemá přístup
a nemá je dělat bez tebe). **Dodrž pořadí kroků 1 → 2.**

## Co bylo špatně a je opravené v kódu

| Problém | Co hrozilo | Oprava |
|---|---|---|
| Otevření appky bez signálu: prázdná data se uložila přes skutečná | **ztráta všech dat** (ověřeno testem: 65 → 0 záznamů) | appka ukládá až po načtení dat ze serveru; server navíc hromadné smazání odmítne |
| Dva telefony nebo záložky: starší stav přepsal novější | ztráta posledních zápisů (ověřeno testem) | každá změna je transakce nad aktuálními daty a mění jen svůj den |
| Smazání záznamu jedním klepnutím, přepsání časů bez dotazu | nechtěné smazání | potvrzovací krok |
| Žádná historie ani záloha | nešlo nic vrátit | historie verzí v databázi, „Stáhnout zálohu“, denní záloha v Cloudflare |
| Poškozená data se tiše přepsala prázdnými | ztráta dat | appka nic nepřepíše a ukáže chybu |
| Text z databáze se vkládal do stránky jako HTML (XSS) | spuštění cizího kódu v appce (ověřeno testem) | escapování, žádné inline `onclick` |
| Knihovna ikon jako JavaScript z unpkg bez verze | kdokoli s přístupem k balíčku mohl spustit kód v appce | pevná verze, jen CSS a kontrolní otisk (integrity) |
| Service worker ukládal do mezipaměti i komunikaci s databází | data docházky v mezipaměti telefonu, neomezený růst | ukládá jen soubory appky |
| Bez pravidel v repozitáři: přístup měl nejspíš kdokoli přihlášený | cizí účet mohl data číst i smazat | `firestore.rules`: jen mamčin účet, bez mazání, povinná historie |

## Postup nasazení

### 1. Nasadit appku

1. Slouč větev `claude/adoring-albattani-iz8pn5` do `main` (pull request). GitHub Pages ji do pár
   minut zveřejní.
2. Na mamčině telefonu appku úplně zavři (vyswipuj) a znovu otevři, klidně dvakrát. Novou verzi
   poznáš tak, že v Nastavení dole je sekce „Záloha a historie“.

Do nasazení nových pravidel appka normálně ukládá. Historie se ukládá už teď, pokud to současná
pravidla dovolí, jinak se zapne s novými pravidly.

### 2. Nasadit pravidla databáze

1. UID mamčina účtu je už ve `firestore.rules` doplněné (funkce `ownerUids()`). Kdyby se účet
   někdy měnil: Firebase konzole → Authentication → Users → „User UID“ a přepsat ho tam.
2. Ověř, že mamka už má novou verzi appky (v Nastavení je „Záloha a historie“).
3. Firebase konzole → Firestore Database → Rules → vlož celý obsah `firestore.rules` → Publish.
   Nebo z počítače: `npx firebase deploy --only firestore:rules --project evidence-dochazky`.
4. Ověření: v appce změň libovolný záznam. Ve Firestore se objeví `dochazka/entries/history/…`
   a v appce v Nastavení → Historie změn je vidět verze.

Když appka po nasazení hlásí „Nemáš oprávnění k datům“, je v pravidlech špatné UID. Oprav ho
a znovu dej Publish – data se tím nepoškodí.

Pravidla odmítnou zápis, který by najednou zmenšil data o víc než ~2000 znaků (desítky dní).
Hromadné úpravy dělej přes Firebase konzoli, ta pravidla obchází.

### 3. Zakázat zakládání cizích účtů

Firebase konzole → Authentication → Settings → User actions:

- vypni **Enable create (sign-up)** – nikdo si přes veřejný API klíč nezaloží vlastní účet,
- vypni **Enable delete**,
- zkontroluj, že je zapnutá **Email enumeration protection**.

Nový účet pak jde založit jen v konzoli (Users → Add user).

### 4. Změnit mamce heslo

Starší verze appky měla přihlašovací jméno a heslo přímo v kódu a ty jsou dodnes veřejně vidět
v historii repozitáře (commity před commitem „security“). Pokud je současné heslo stejné nebo
podobné, nebo ho mamka používá i jinde, změň ho (Authentication → Users → ⋮ → Reset password).
Přepisovat historii gitu nemá smysl – kdokoli si ji už mohl stáhnout; pomůže jen změna hesla.

### 5. Omezit API klíč na adresu appky

Google Cloud Console → projekt `evidence-dochazky` → APIs & Services → Credentials →
„Browser key (auto created by Firebase)“ → Application restrictions → Websites →
přidej `https://t0byx.github.io/*` → Save.

API klíč je ve veřejném kódu záměrně, u Firebase je to normální. Omezení jen ztíží jeho zneužití
z jiných webů.

### 6. Denní zálohy mimo Firebase (Cloudflare)

1. KV namespace `dochazka-zalohy` už je založený (17. 11. 2026 přes Cloudflare konektor).
2. Workers & Pages → `dochazka-notify` → Settings → Bindings → Add → KV namespace:
   název proměnné `BACKUPS`, namespace `dochazka-zalohy`.
3. Workers & Pages → `dochazka-notify` → Edit code → nahraď obsahem souboru
   `worker/dochazka-notify.js` → Deploy.
4. Ověření: otevři `https://dochazka-notify.<tvoje-subdoména>.workers.dev/backup-now?key=<ADMIN_KEY>`.
   Má se ukázat „Záloha rucni-… uložena (N záznamů)“. Potom se každý den po 2:00 uloží
   `zaloha-RRRR-MM-DD` a drží se 400 dní.

Bez kroků 1–2 funguje nový kód Workeru úplně stejně jako ten současný, jen bez záloh.

### 7. Volitelné: zálohy přímo ve Firebase

Na tarifu Blaze (platba podle použití, pro takhle malá data prakticky zadarmo):

- Firestore → Disaster recovery → zapni Point-in-time recovery (návrat až 7 dní zpět),
- případně denní zálohy:
  `gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14w --project evidence-dochazky`

### 8. Volitelné: ochrana větve main

GitHub → Settings → Branches → pravidlo pro `main`: vyžadovat pull request a úspěšnou kontrolu
„Kontroly a testy“. Pak se k mamce nedostane kód, který neprošel testy.

## Jak obnovit data

1. **V appce** (nejjednodušší): Nastavení → Záloha a historie → Historie změn → u verze před
   problémem „Vrátit“. Současný stav se předtím uloží do historie, takže i obnovu jde vrátit.
2. **Firebase konzole**: Firestore → `dochazka` → `entries` → `history` → vyber verzi podle
   `savedAt` a `reason` (je to stav *před* danou změnou) → zkopíruj hodnotu `json` → vlož ji
   do pole `json` v dokumentu `dochazka/entries`.
3. **Cloudflare KV**: KV → `dochazka-zalohy` → `zaloha-RRRR-MM-DD` → v hodnotě je pole `json`
   → vlož ho jako v bodě 2.
4. **Soubor ze „Stáhnout zálohu“**: obsahuje `entries` a `settings`. Do pole `json` patří text
   ve tvaru `{"entries": …, "settings": …}`.

## Automatické kontroly

- **GitHub Actions** („Kontroly a testy“) při každé změně: syntaxe, tajemství v souborech,
  pojistky, Worker, pravidla databáze a celá appka v prohlížeči proti lokálním emulátorům.
- **Claude Code** (`.claude/settings.json`): zablokuje nevratné příkazy proti produkci (mazání
  ve Firestore nebo Cloudflare, přímé zápisy do databáze přes konektory, force push do `main`),
  u nasazení se vždy zeptá a po každé úpravě souboru appky zkontroluje syntaxi.
- **Příkazy pro Claude**: `/nasazeni` (postup nasazení s kontrolami), `/obnova-dat` (když zmizí data)
  a subagent `data-safety-reviewer` (kontrola změn před pull requestem).
- **Firebase pro Claude jen pro čtení** (`.mcp.json`): když na svém počítači spustíš
  `npx firebase login` a pak Claude Code v této složce, Claude uvidí produkční pravidla, data
  a historii verzí (třeba při `/obnova-dat`), ale nic nezmění – nástroje pro zápis vůbec nedostane.
