---
name: obnova-dat
description: Postup, když v Docházce zmizí nebo se pokazí data (záznamy chybí, appka hlásí chybu dat, omylem smazáno). Najde poslední dobrou verzi a provede člověka obnovou. Spouští jen člověk příkazem /obnova-dat.
disable-model-invocation: true
---

# Obnova dat Docházky

Cíl: najít poslední dobrou verzi dat a bezpečně ji vrátit. **Do produkční databáze sám nezapisuj**
(pojistky to blokují) – obnovu provede člověk v appce nebo v konzoli. Nic nemaž.

## 1. Zjisti, co se stalo

Zeptej se (pokud to ještě není jasné): co chybí, od kdy, na kterém zařízení, co se dělo předtím
(offline, jiný telefon, smazání). Nic zatím neměň.

## 2. Podívej se na data (jen čtení)

Když je k dispozici read-only Firebase MCP (`firebase-readonly`, po `firebase login`):

1. `firestore_get_document` → `dochazka/entries`: přečti pole `json`, spočítej záznamy (`entries`)
   a zkontroluj, že jde JSON přečíst.
2. `firestore_list_documents` / `firestore_query_collection` → `dochazka/entries/history`:
   seřaď podle `savedAt` a ke každé verzi uveď čas, `reason` (stav *před* touto změnou) a počet záznamů.
3. Najdi poslední verzi, kde data ještě byla v pořádku, a ukaž rozdíl proti současnému stavu
   (které dny chybí nebo se liší).

Bez MCP požádej člověka o export z appky (Nastavení → Stáhnout zálohu) nebo o čísla z konzole.

## 3. Obnova – vyber nejjednodušší cestu

1. **V appce** (nejlepší, vše zůstane v historii): Nastavení → Záloha a historie → Historie změn →
   u nalezené verze „Vrátit“. Současný stav se předtím uloží do historie, takže i obnova jde vrátit.
2. **Firebase konzole** – když appka obnovu odmítne (pravidla nedovolí najednou zmenšit data o víc
   než 2000 znaků) nebo appka nejde otevřít: Firestore → `dochazka/entries/history/<id>` → zkopírovat
   hodnotu `json` → vložit do pole `json` v `dochazka/entries`. Konzole pravidla obchází.
3. **Cloudflare KV** – když chybí i historie: KV `dochazka-zalohy` → klíč `zaloha-RRRR-MM-DD`
   → v hodnotě je pole `json` → vložit jako v bodě 2.
4. **Soubor ze „Stáhnout zálohu“**: do pole `json` patří `{"entries": …, "settings": …}`.

## 4. Po obnově

1. Ověř (čtením), že `dochazka/entries` má očekávaný počet záznamů a appka data ukazuje.
2. Najdi příčinu (`reason` v historii, čas, zařízení) a navrhni opravu + test v `tests/`,
   aby se to nemohlo opakovat. Shrň to pro člověka.
