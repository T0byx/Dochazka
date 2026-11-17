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
