// Testy Cloudflare Workeru (upozornění + denní záloha) se simulovaným Google API a KV – bez sítě.
// Spuštění: npm run test:worker
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SERVICE_ACCOUNT = JSON.stringify({ project_id: 'demo-dochazka', client_email: 'worker@demo-dochazka.iam.gserviceaccount.com', private_key: privateKey });
const worker = (await import('../worker/dochazka-notify.js')).default;

// zimní čas: Praha = UTC+1
const pragueTime = (date, hm) => Date.parse(`${date}T${hm}:00+01:00`);

let google, errors;

function fakeGoogle(entriesJson, push = { tokens: ['telefon-1'] }) {
  const state = { entriesJson, push, sent: [], patches: [] };
  state.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'token', expires_in: 3600 });
    if (u.endsWith('/documents/dochazka/entries')) {
      return state.entriesJson == null ? new Response('', { status: 404 })
        : Response.json({ fields: { json: { stringValue: state.entriesJson } }, updateTime: '2026-01-15T00:00:00Z' });
    }
    if (u.endsWith('/documents/dochazka/push')) {
      const fields = { tokens: { arrayValue: { values: state.push.tokens.map(t => ({ stringValue: t })) } } };
      if (state.push.lastNotifiedDate) fields.lastNotifiedDate = { stringValue: state.push.lastNotifiedDate };
      return Response.json({ fields });
    }
    if (u.includes('/documents/dochazka/push?updateMask')) { state.patches.push(JSON.parse(init.body)); return Response.json({}); }
    if (u.startsWith('https://fcm.googleapis.com/')) { state.sent.push(JSON.parse(init.body)); return Response.json({ name: 'ok' }); }
    return new Response('neočekávané volání ' + u, { status: 500 });
  };
  return state;
}

function fakeKV() {
  const store = new Map();
  let puts = 0;
  return {
    store,
    get puts() { return puts; },
    async get(key) { return store.has(key) ? store.get(key).value : null; },
    async put(key, value, opts) { puts++; store.set(key, { value, opts }); },
  };
}

async function runScheduled(env) {
  const waits = [];
  await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: p => waits.push(p) });
  await Promise.all(waits);
}

const data = (entries, settings = {}) => JSON.stringify({
  entries,
  settings: { notifyEnabled: true, notifyMinutes: 15, workDayLength: 8, countBreak: true, breakMinutes: 30, ...settings },
});

beforeEach(() => {
  errors = [];
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', (...a) => {
    const msg = a.join(' ');
    if (!msg.includes('ExperimentalWarning')) errors.push(msg); // varování Node o mock.timers nevadí
  });
});
afterEach(() => { mock.timers.reset(); mock.restoreAll(); });

function at(date, hm, state) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: pragueTime(date, hm) });
  google = state;
  globalThis.fetch = state.fetch;
}

test('upozornění funguje jako dřív (bez KV zálohy)', async () => {
  at('2026-01-15', '15:20', fakeGoogle(data({ '2026-01-15': { type: 'work', checkIn: '07:00' } })));
  await runScheduled({ SERVICE_ACCOUNT });
  assert.equal(google.sent.length, 1);
  assert.match(google.sent[0].message.notification.body, /Za 10 min ti končí směna \(15:30\)/);
  assert.deepEqual(google.patches.at(-1), { fields: { lastNotifiedDate: { stringValue: '2026-01-15' } } });
  assert.deepEqual(errors, []);
});

test('mimo konec směny se nic neposílá', async () => {
  at('2026-01-15', '10:00', fakeGoogle(data({ '2026-01-15': { type: 'work', checkIn: '07:00' } })));
  await runScheduled({ SERVICE_ACCOUNT });
  assert.equal(google.sent.length, 0);
  assert.deepEqual(errors, []);
});

test('denní záloha: před 2:00 nic, po 2:00 právě jednou za den, drží se 400 dní', async () => {
  const json = data({ '2026-01-14': { type: 'work', checkIn: '07:00', checkOut: '15:30' }, '2026-01-13': { type: 'sickday' } });
  const BACKUPS = fakeKV();

  at('2026-01-16', '01:30', fakeGoogle(json));
  await runScheduled({ SERVICE_ACCOUNT, BACKUPS });
  assert.equal(BACKUPS.puts, 0, 'před 2:00 se nezálohuje');

  at('2026-01-16', '02:05', fakeGoogle(json));
  await runScheduled({ SERVICE_ACCOUNT, BACKUPS });
  const saved = BACKUPS.store.get('zaloha-2026-01-16');
  assert.ok(saved, 'záloha je uložená');
  assert.equal(JSON.parse(saved.value).json, json, 'záloha obsahuje přesná data');
  assert.equal(JSON.parse(saved.value).entries, 2);
  assert.equal(saved.opts.expirationTtl, 400 * 86400);

  at('2026-01-16', '02:06', fakeGoogle(json));
  await runScheduled({ SERVICE_ACCOUNT, BACKUPS });
  at('2026-01-16', '18:00', fakeGoogle(json));
  await runScheduled({ SERVICE_ACCOUNT, BACKUPS });
  assert.equal(BACKUPS.puts, 1, 'za den jen jedna záloha');

  at('2026-01-17', '02:01', fakeGoogle(json));
  await runScheduled({ SERVICE_ACCOUNT, BACKUPS });
  assert.ok(BACKUPS.store.get('zaloha-2026-01-17'), 'další den nová záloha');
  assert.ok(BACKUPS.store.get('zaloha-2026-01-16'), 'stará záloha zůstává');
  assert.deepEqual(errors, []);
});

test('záloha uloží i poškozená data (kvůli ruční opravě) a upozornění nespadnou', async () => {
  const BACKUPS = fakeKV();
  at('2026-01-18', '03:00', fakeGoogle('{poškozená data'));
  await runScheduled({ SERVICE_ACCOUNT, BACKUPS });
  const saved = JSON.parse(BACKUPS.store.get('zaloha-2026-01-18').value);
  assert.equal(saved.json, '{poškozená data');
  assert.equal(saved.entries, null);
});

test('ruční záloha /backup-now funguje jen s ADMIN_KEY', async () => {
  const BACKUPS = fakeKV();
  at('2026-01-19', '12:34', fakeGoogle(data({})));
  const env = { SERVICE_ACCOUNT, BACKUPS, ADMIN_KEY: 'tajny-klic-pro-test' };

  const anon = await worker.fetch(new Request('https://worker.example/backup-now'), env);
  assert.match(await anon.text(), /běží/);
  const wrong = await worker.fetch(new Request('https://worker.example/backup-now?key=spatne'), env);
  assert.match(await wrong.text(), /běží/);
  assert.equal(BACKUPS.puts, 0);

  const ok = await worker.fetch(new Request('https://worker.example/backup-now?key=tajny-klic-pro-test'), env);
  assert.match(await ok.text(), /Záloha rucni-2026-01-19-1234 uložena/);
  assert.equal(BACKUPS.puts, 1);
});
