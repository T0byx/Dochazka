// Testy celé appky v prohlížeči proti lokálním emulátorům Firebase – nikdy proti produkci.
// Ověřují hlavně ochranu dat: offline start, dvě zařízení, potvrzení smazání, historie, XSS.
//
// Spuštění: npm run test:e2e   (spustí emulátory Firestore + Auth a Playwright/Chromium)
// Bez přístupu k CDN (sandbox): LOCAL_CDN_DIR=/cesta npm run test:e2e
//   adresář obsahuje firebasejs/10.12.2/*.js, phosphor/style.css (+ fonty) a tailwind.js
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = 'demo-dochazka';
const FS = 'http://127.0.0.1:8080';
const AUTH = 'http://127.0.0.1:9099';
const DOCS = `${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;
const ADMIN = { Authorization: 'Bearer owner' }; // emulátor: obejde pravidla – jen pro přípravu/kontrolu dat
const EMAIL = 'mama@example.com';
const PASSWORD = 'testovaci-heslo-123';
const LOCAL_CDN = process.env.LOCAL_CDN_DIR;

const pad = n => String(n).padStart(2, '0');
const NOW = new Date();
const YEAR = NOW.getFullYear();
const YM = `${YEAR}-${pad(NOW.getMonth() + 1)}`;
const day = d => `${YM}-${pad(d)}`;

let server, baseUrl, browser;
const contexts = [];
const pages = [];

// ---------- příprava ----------

before(async () => {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise(r => server.close(r));
});

let ownerUid;
beforeEach(async () => {
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=test-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  ownerUid = (await res.json()).localId;
  assert.ok(ownerUid, 'testovací účet se nepodařilo založit');
  // skutečná pravidla z firestore.rules, jen s UID testovacího účtu
  const rules = readFileSync(join(ROOT, 'firestore.rules'), 'utf8')
    .replace(/function ownerUids\(\) \{[^}]*\}/, `function ownerUids() { return ['${ownerUid}']; }`);
  const put = await fetch(`${FS}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: rules }] } }),
  });
  assert.ok(put.ok, 'pravidla se nenahrála: ' + await put.text());
});

afterEach(async () => {
  const errors = pages.flatMap(p => p.pageErrors);
  pages.length = 0;
  for (const c of contexts.splice(0)) await c.close();
  assert.deepEqual(errors.map(e => String(e)), [], 'v appce nastala neošetřená chyba JavaScriptu');
});

// ---------- pomocné funkce ----------

function sampleData(extra = {}) {
  const entries = {};
  // starší data (minulý rok), ať jsou data realisticky velká
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(YEAR - 1, 2, 1 + i)).toISOString().slice(0, 10);
    entries[d] = { type: 'work', checkIn: '07:30', checkOut: '16:00' };
  }
  for (let d = 1; d <= 5; d++) entries[day(d)] = { type: 'work', checkIn: '07:30', checkOut: '16:00' };
  Object.assign(entries, extra);
  return { entries, settings: { workDayLength: 8, countBreak: true, breakMinutes: 30, autoHolidays: true, allotments: { [YEAR]: { vacation: 20, sick: 5 } } } };
}

async function seedMain(data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  const res = await fetch(`${DOCS}/dochazka/entries`, {
    method: 'PATCH', headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { json: { stringValue: json }, updatedAt: { integerValue: '1' } } }),
  });
  assert.ok(res.ok, await res.text());
  return json;
}

async function readMain() {
  const res = await fetch(`${DOCS}/dochazka/entries`, { headers: ADMIN });
  if (res.status === 404) return null;
  const f = (await res.json()).fields;
  let data = null;
  try { data = JSON.parse(f.json.stringValue); } catch { /* poškozená data */ }
  return { json: f.json.stringValue, data, prevHistoryId: f.prevHistoryId?.stringValue };
}

async function readHistory() {
  const res = await fetch(`${DOCS}/dochazka/entries/history?pageSize=100`, { headers: ADMIN });
  const docs = (await res.json()).documents || [];
  return docs.map(d => ({ id: d.name.split('/').pop(), json: d.fields.json.stringValue, reason: d.fields.reason?.stringValue }));
}

async function eventually(check, what, timeout = 15000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { if (await check()) return; } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 200));
  }
  assert.fail(`nesplnilo se do ${timeout} ms: ${what}${last ? ' (' + last.message + ')' : ''}`);
}

async function newContext() {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  contexts.push(context);
  if (LOCAL_CDN) {
    await context.route(/^https:\/\/(www\.gstatic\.com|cdn\.jsdelivr\.net|cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => {
      const url = new URL(route.request().url());
      let file = null;
      if (url.hostname === 'www.gstatic.com') file = join(LOCAL_CDN, url.pathname);
      else if (url.hostname === 'cdn.jsdelivr.net') file = join(LOCAL_CDN, 'phosphor', url.pathname.split('/').pop());
      else if (url.hostname === 'cdn.tailwindcss.com') file = join(LOCAL_CDN, 'tailwind.js');
      if (!file || !existsSync(file)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      return route.fulfill({ status: 200, contentType, body: readFileSync(file), headers: { 'Access-Control-Allow-Origin': '*' } });
    });
  }
  return context;
}

async function openApp(context) {
  const page = await context.newPage();
  page.pageErrors = [];
  page.on('pageerror', e => page.pageErrors.push(e));
  pages.push(page);
  await page.goto(`${baseUrl}/index.html?emulator`);
  return page;
}

async function login(page) {
  await page.fill('#loginUser', EMAIL);
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
}

const waitReady = page => page.waitForFunction(() => dataReady === true && !dataError, null, { timeout: 20000 });

async function openLoggedIn(context) {
  const page = await openApp(context || await newContext());
  await login(page);
  await waitReady(page);
  return page;
}

// ---------- testy ----------

test('zápis příchodu uloží data a předchozí verzi do historie', { timeout: 60000 }, async () => {
  const seeded = await seedMain(sampleData());
  const page = await openLoggedIn();
  // ikony: zamčená verze s kontrolním otiskem se opravdu načetla
  assert.ok(await page.evaluate(() => [...document.styleSheets].some(s => (s.href || '').includes('phosphor-icons') && s.cssRules.length > 0)),
    'styl ikon se nenačetl (nesedí integrity?)');

  const today = day(20);
  await page.click('#addDayBtn');
  await page.fill('#pickDateInput', today);
  await page.click('#pickDateGo');
  await page.click('[data-action="checkIn"]');
  await page.fill('#timeInput', '07:45');
  await page.click('#saveTime');

  await eventually(async () => (await readMain()).data.entries[today]?.checkIn === '07:45', 'příchod je uložený');
  const main = await readMain();
  assert.equal(Object.keys(main.data.entries).length, Object.keys(JSON.parse(seeded).entries).length + 1, 'ostatní dny zůstaly');
  const history = await readHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].json, seeded, 'v historii je přesně předchozí verze');
  assert.equal(main.prevHistoryId, history[0].id);
  await page.locator(`tr[data-key="${today}"]`).waitFor();
});

test('smazání chce potvrzení; Zrušit nic nesmaže; smazaný den jde vrátit z historie', { timeout: 60000 }, async () => {
  const seeded = await seedMain(sampleData());
  const page = await openLoggedIn();

  await page.click(`tr[data-key="${day(3)}"]`);
  await page.click('#clearBtn');
  await page.getByText('Smazat záznam?').waitFor();
  await page.click('#confirmNo');
  await page.locator('#clearBtn').waitFor();
  await new Promise(r => setTimeout(r, 500));
  assert.equal((await readMain()).json, seeded, 'po Zrušit se nic nezměnilo');

  await page.click('#clearBtn');
  await page.click('#confirmYes');
  await eventually(async () => !(day(3) in (await readMain()).data.entries), 'den je smazaný');
  const afterDelete = (await readMain()).data;
  assert.equal(Object.keys(afterDelete.entries).length, Object.keys(JSON.parse(seeded).entries).length - 1, 'smazal se jen jeden den');
  assert.equal((await readHistory())[0].json, seeded);

  // obnova z historie v nastavení
  await page.click('#openSettings');
  await page.click('#historyBtn');
  page.once('dialog', d => d.accept());
  await page.locator('#historyList button', { hasText: 'Vrátit' }).first().click();
  await eventually(async () => day(3) in (await readMain()).data.entries, 'den je zpět');
  assert.equal((await readMain()).json, seeded, 'data jsou přesně jako před smazáním');
  assert.equal((await readHistory()).length, 2, 'i stav před obnovou je v historii');
});

test('přepsání dne s časy jiným záznamem chce potvrzení', { timeout: 60000 }, async () => {
  const seeded = await seedMain(sampleData());
  const page = await openLoggedIn();
  await page.click(`tr[data-key="${day(2)}"]`);
  await page.click('#addBtn');
  await page.click('[data-type="sickday"]');
  await page.getByText('Přepsat zapsané časy?').waitFor();
  await page.click('#confirmNo');
  await page.locator('[data-type="sickday"]').waitFor();
  assert.equal((await readMain()).json, seeded);

  await page.click('[data-type="sickday"]');
  await page.click('#confirmYes');
  await eventually(async () => (await readMain()).data.entries[day(2)]?.type === 'sickday', 'den je přepsaný na sickday');
});

test('spuštění bez spojení s databází nepřepíše data prázdnými (dřívější chyba)', { timeout: 90000 }, async () => {
  const seeded = await seedMain(sampleData());
  const context = await newContext();
  const page = await openLoggedIn(context); // přihlášení si prohlížeč pamatuje

  // telefon bez signálu do databáze: appka se znovu otevře, přihlášení funguje, databáze ne
  await context.route(/127\.0\.0\.1:8080/, route => route.abort());
  await page.reload();
  await page.getByText('Nejde se spojit s databází').waitFor({ timeout: 30000 });
  assert.equal(await page.isDisabled('#addDayBtn'), true, 'bez dat nejde přidat záznam');
  assert.equal(await page.isVisible('#emptyState'), false, 'appka netvrdí, že je měsíc prázdný');
  assert.equal(await page.textContent('#monthFund'), '–', 'bez dat se fond ani počty neukazují');
  assert.equal(await page.textContent('#countedHours'), '–');
  assert.equal(await page.textContent('#vacLeft'), '–');
  assert.equal(await page.evaluate(() => updateDay('2030-01-01', () => ({ type: 'sickday' }))), false, 'uložení je zablokované');

  // signál se vrátí
  await context.unroute(/127\.0\.0\.1:8080/);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitReady(page);
  await page.locator(`tr[data-key="${day(1)}"]`).waitFor();
  await new Promise(r => setTimeout(r, 1500));
  assert.equal((await readMain()).json, seeded, 'data v databázi zůstala netknutá');
  assert.equal((await readHistory()).length, 0, 'nic se nezapisovalo');
});

test('dvě zařízení: zastaralá data na jednom nepřepíšou změnu z druhého', { timeout: 90000 }, async () => {
  await seedMain(sampleData());
  const pageA = await openLoggedIn();
  const pageB = await openLoggedIn();
  // zařízení B přestane dostávat novinky (např. bylo chvíli bez signálu) → má stará data
  await pageB.evaluate(() => unsubscribeSync());

  // zařízení A zapíše sickday na 10. den
  await pageA.click('#addDayBtn');
  await pageA.fill('#pickDateInput', day(10));
  await pageA.click('#pickDateGo');
  await pageA.click('[data-type="sickday"]');
  await eventually(async () => (await readMain()).data.entries[day(10)]?.type === 'sickday', 'A uložilo sickday');
  assert.equal(await pageB.evaluate(d => !!entries[d], day(10)), false, 'B o změně z A neví');

  // zařízení B smaže 3. den
  await pageB.click(`tr[data-key="${day(3)}"]`);
  await pageB.click('#clearBtn');
  await pageB.click('#confirmYes');
  await eventually(async () => !(day(3) in (await readMain()).data.entries), 'B smazalo 3. den');
  const final = (await readMain()).data.entries;
  assert.equal(final[day(10)]?.type, 'sickday', 'změna ze zařízení A přežila');
  assert.ok(final[day(1)] && final[day(5)], 'ostatní dny zůstaly');
});

test('poškozená data v databázi se nepřepíšou', { timeout: 60000 }, async () => {
  const broken = '{"entries": {"2026-01-05": {"type": "work"';
  await seedMain(broken);
  const page = await openApp(await newContext());
  await login(page);
  await page.getByText('Data v databázi se nepodařilo přečíst').waitFor();
  assert.equal(await page.isDisabled('#addDayBtn'), true);
  await page.click('#openSettings');
  await page.click('#saveSettings');
  await page.getByText('Neuloženo').first().waitFor();
  await new Promise(r => setTimeout(r, 1000));
  assert.equal((await readMain()).json, broken, 'poškozená data zůstala, jak byla (dají se opravit ručně)');
});

test('text z databáze se v appce nevykoná jako kód (XSS)', { timeout: 60000 }, async () => {
  await seedMain(sampleData({
    [day(6)]: { type: 'work', checkIn: '<img src=x onerror="window.__xss=1">', checkOut: '16:00' },
    [day(7)]: { type: '<img src=x onerror="window.__xss=2">' },
    [`${YM}-08'); window.__xss=3; ('`]: { type: 'sickday' },
    [day(9)]: null,
    [day(11)]: { type: 'work', checkIn: 800, checkOut: 1600 }, // čas jako číslo (ruční úprava) nesmí shodit tabulku
  }));
  const page = await openLoggedIn();
  await page.locator(`tr[data-key="${day(7)}"]`).waitFor();
  await page.click(`tr[data-key="${day(6)}"]`);
  await page.getByText('<img src=x onerror="window.__xss=1">').first().waitFor();
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'žádný vložený kód se nespustil');
});

test('nový účet bez dat: appka založí dokument (bez historie)', { timeout: 60000 }, async () => {
  const page = await openLoggedIn();
  await eventually(async () => (await readMain())?.data?.settings?.allotments?.[YEAR], 'založený dokument s nárokem na letošní rok');
  assert.equal((await readHistory()).length, 0);
  assert.equal(await page.isDisabled('#addDayBtn'), false, 'záznamy jde přidávat');
});

test('záloha do zařízení obsahuje aktuální data', { timeout: 60000 }, async () => {
  const seeded = JSON.parse(await seedMain(sampleData()));
  const page = await openLoggedIn();
  await page.click('#openSettings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  assert.match(download.suggestedFilename(), /^dochazka-zaloha-\d{4}-\d{2}-\d{2}\.json$/);
  const backup = JSON.parse(readFileSync(await download.path(), 'utf8'));
  assert.deepEqual(backup.entries, seeded.entries);
  assert.deepEqual(backup.settings, seeded.settings);
});

test('nový rok: appka vyzve k nastavení nároku, čerpání začne od nuly a po uložení výzva zmizí', { timeout: 60000 }, async () => {
  // nárok je nastavený jen na loňský rok a loni byla vybraná dovolená
  const data = sampleData({ [`${YEAR - 1}-07-15`]: { type: 'dovolena' } });
  data.settings = { workDayLength: 8, countBreak: true, breakMinutes: 30, vacationDaysTotal: 20, sickDaysTotal: 5, allotments: { [YEAR - 1]: { vacation: 20, sick: 5 } } };
  await seedMain(data);
  const page = await openLoggedIn();

  await page.locator('#yearBanner').waitFor();
  assert.equal(await page.textContent('#yearBannerTitle'), `Nový rok ${YEAR}`);
  await page.click('#yearBannerBtn');
  assert.equal(await page.textContent('#quotaTitle'), `Nárok na rok ${YEAR} (dní)`);
  await page.fill('#setVacation', '25');
  await page.fill('#setSickdays', '4');
  // nesmyslné hodnoty v nastavení se neuloží
  await page.fill('#setWorkLen', '-8');
  await page.fill('#setBreakMin', '-30');
  await page.click('#saveSettings');

  await eventually(async () => (await readMain()).data.settings.allotments?.[YEAR]?.vacation === 25, 'nárok na nový rok je uložený');
  const saved = (await readMain()).data.settings;
  assert.equal(saved.workDayLength, 8, 'záporná délka směny se neuloží');
  assert.equal(saved.breakMinutes, 0, 'záporná přestávka se neuloží');
  const allotments = saved.allotments;
  assert.deepEqual(allotments[YEAR], { vacation: 25, sick: 4 });
  assert.deepEqual(allotments[YEAR - 1], { vacation: 20, sick: 5 }, 'loňský nárok zůstal beze změny');
  await page.locator('#yearBanner').waitFor({ state: 'hidden' });
  assert.equal(await page.textContent('#vacLeft'), 'Dostupné 25 dnů', 'loňská dovolená se do letoška nepočítá');
  assert.equal(await page.textContent('#sickLeft'), 'Dostupné 4 dny');
});

test('fond pracovní doby měsíce podle kalendáře (jako plánovací kalendář)', { timeout: 60000 }, async () => {
  await seedMain(sampleData());
  const page = await openLoggedIn();

  // rok 2026: pracovní dny po–pá bez státních svátků (spočítáno nezávisle na appce)
  const expected2026 = [21, 20, 22, 20, 19, 22, 22, 21, 21, 21, 20, 21];
  const funds = await page.evaluate(() => Array.from({ length: 12 }, (_, m) => monthFund(2026, m)));
  assert.deepEqual(funds.map(f => f.workDays), expected2026);
  assert.deepEqual(funds.map(f => f.hours), expected2026.map(d => d * 8));

  // přehled ukazuje fond zobrazeného měsíce a při přepnutí měsíce se změní
  for (const step of [null, '#nextMonth', '#prevMonth', '#prevMonth']) {
    if (step) await page.click(step);
    const f = await page.evaluate(() => monthFund(year, month));
    assert.equal(await page.textContent('#fundLabel'), `Fond (${f.workDays} dní)`);
    assert.equal(await page.textContent('#monthFund'), `${f.hours}:00`);
  }

  // kratší směna (7,5 h) se do fondu promítne: listopad 2026 = 20 dní × 7,5 h
  assert.equal(await page.evaluate(() => { settings.workDayLength = 7.5; return monthFund(2026, 10).hours; }), 150);
  // nesmyslná délka směny z databáze (záporná, text) → počítá se s 8 h
  assert.equal(await page.evaluate(() => { settings.workDayLength = -8; return monthFund(2026, 10).hours; }), 160);
  assert.equal(await page.evaluate(() => { settings.workDayLength = 'abc'; return dayTarget({ type: 'work' }); }), 8);
});

test('placené volno (dovolená, lékař, sickday) se počítá do hodin a sedí s fondem', { timeout: 60000 }, async () => {
  // listopad 2026: fond 20 dní × 8 h = 160 h (17. 11. je státní svátek)
  const entries = {
    '2026-11-02': { type: 'work', checkIn: '07:30', checkOut: '16:00' },               // 8:00 odpracováno
    '2026-11-03': { type: 'dovolena' },                                                 // 8:00 placené volno
    '2026-11-04': { type: 'doktor' },                                                   // 8:00 placené volno
    '2026-11-05': { type: 'sickday' },                                                  // 8:00 placené volno
    '2026-11-06': { type: 'neplacene' },                                                // nepočítá se
    '2026-11-09': { type: 'work', checkIn: '07:30', checkOut: '11:30', halfVac: true }, // 4:00 + 4:00 (½ dne dovolené)
    '2026-11-14': { type: 'work', checkIn: '08:00', checkOut: '12:00' },               // sobota: 3:30, celé navíc
    '2026-11-17': { type: 'dovolena' },                                                 // státní svátek: nepočítá se
  };
  await seedMain({ entries, settings: { workDayLength: 8, countBreak: true, breakMinutes: 30, autoHolidays: true, allotments: { 2026: { vacation: 20, sick: 5 } } } });
  const page = await openLoggedIn();
  await page.evaluate(() => { year = 2026; month = 10; render(); });

  assert.equal(await page.textContent('#totalHours'), '15:30', 'odpracováno: 8 + 4 + 3:30');
  assert.equal(await page.textContent('#paidLeave'), '28:00', 'placené volno: 3 × 8 + ½ dne');
  assert.equal(await page.textContent('#countedHours'), '43:30');
  assert.equal(await page.textContent('#monthFund'), '160:00');
  assert.equal(await page.textContent('#totalSaldo'), '+3:30', 'sobota je celá navíc, ostatní dny přesně');
  assert.equal(await page.textContent('#monthTotal'), '43:30 (+3:30)');

  // týdny: 2.–8. 11. = 8 + 3 × 8 h; 9.–15. 11. = 4 + 4 + 3:30
  const weeks = await page.$$eval('#weeksContainer tr.bg-slate-100', rows => rows.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
  assert.ok(weeks.includes('Týden 45 32:00 (0:00)'), weeks.join(' | '));
  assert.ok(weeks.includes('Týden 46 11:30 (+3:30)'), weeks.join(' | '));

  // řádky: placené volno má ve sloupci Celkem celou směnu, neplacené volno a dovolená ve svátek nic
  const cells = d => page.$$eval(`tr[data-key="2026-11-${d}"] td`, tds => tds.map(td => td.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual((await cells('03')).slice(1), ['Dovolená', '8:00', '–']);
  assert.deepEqual((await cells('04')).slice(1), ['Doktor', '8:00', '–']);
  assert.deepEqual((await cells('06')).slice(1), ['Neplacené volno', '–', '–']);
  assert.deepEqual((await cells('09')).slice(4), ['4:00', '8:00', '0:00'], 'Hod, Celkem (4 h + ½ dne), Saldo');
  assert.deepEqual((await cells('14')).slice(4), ['4:00', '3:30', '+3:30'], 'sobota: saldo celé plus');
  assert.deepEqual((await cells('17')).slice(1), ['Dovolená', '–', '–']);

  // detail dne vysvětlí, jak se den počítá
  await page.click('tr[data-key="2026-11-04"]');
  await page.getByText('Do hodin se počítá 8:00 h (placené volno).').waitFor();
});

test('součty sedí i u nekulaté směny (7,75 h) a neexistující datum se nepočítá', { timeout: 60000 }, async () => {
  const entries = {
    '2026-11-02': { type: 'work', checkIn: '08:00', checkOut: '12:00', halfVac: true }, // týden 45: 4:00 + ½ směny 3:53
    '2026-11-10': { type: 'work', checkIn: '08:00', checkOut: '12:00', halfVac: true }, // týden 46: totéž
    '2026-11-31': { type: 'dovolena' },                                                 // neexistující den
  };
  await seedMain({ entries, settings: { workDayLength: 7.75, countBreak: true, breakMinutes: 30, autoHolidays: true, allotments: { 2026: { vacation: 20, sick: 5 } } } });
  const page = await openLoggedIn();
  await page.evaluate(() => { year = 2026; month = 10; render(); });

  assert.equal(await page.evaluate(() => fmtDur(halfShiftHours())), '3:53');
  assert.equal(await page.evaluate(() => [isWorkingDay('2026-11-31'), isWorkingDay('2026-11-30'), isWorkingDay('nesmysl')].join()), 'false,true,false');
  const weeks = await page.$$eval('#weeksContainer tr.bg-slate-100', rows => rows.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
  assert.ok(weeks.includes('Týden 45 7:53 (+0:07)'), weeks.join(' | '));
  assert.ok(weeks.includes('Týden 46 7:53 (+0:07)'), weeks.join(' | '));
  // karta = součet týdnů (dřív mohla vyjít o minutu jinak)
  assert.equal(await page.textContent('#totalHours'), '8:00');
  assert.equal(await page.textContent('#paidLeave'), '7:46');
  assert.equal(await page.textContent('#countedHours'), '15:46');
  assert.equal(await page.textContent('#totalSaldo'), '+0:14');
  assert.equal(await page.textContent('#monthFund'), '155:00', '20 dní × 7:45');
});
