// ============================================================
// Docházka – odesílač upozornění (Cloudflare Worker)
//
// Každou minutu (cron) se podívá do databáze, jestli se blíží konec směny
// (příchod + délka pracovního dne + přestávka), a pošle push upozornění
// na telefony, které si upozornění zapnuly v appce.
//
// Potřebuje v nastavení Workeru:
//   SERVICE_ACCOUNT  (Secret)  celý obsah JSON souboru se službovým účtem z Firebase
//   ADMIN_KEY        (Secret)  libovolný dlouhý náhodný text – pro ruční test (nepovinné)
//   APP_URL          (Text)    adresa appky, např. https://t0byx.github.io/Dochazka/ (nepovinné)
//   BACKUPS          (KV namespace binding)  denní zálohy dat mimo Firebase (nepovinné)
//
// Denní záloha: když je navázaný KV namespace BACKUPS, Worker jednou denně (po 2:00)
// uloží kopii všech dat pod klíč „zaloha-RRRR-MM-DD“ a drží ji 400 dní.
// Ruční záloha / test nastavení: https://<worker>/backup-now?key=<ADMIN_KEY>
// ============================================================

const SCOPES = 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging';
const TIMEZONE = 'Europe/Prague';
const DEFAULT_APP_URL = 'https://t0byx.github.io/Dochazka/';
const GRACE_AFTER_END_MIN = 120; // po konci směny už připomínku neposíláme déle než 2 hodiny

// formátovač času se vytváří jen jednou (šetří procesorový čas)
const pragueFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// token pro Google API se drží v paměti, dokud platí (nemusí se každou minutu znovu podepisovat)
let cachedToken = null;

// ---------- pomocné funkce ----------

function pragueNow() {
  const parts = {};
  for (const p of pragueFormat.formatToParts(new Date())) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function hmToMinutes(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
}

function fmtHM(totalMinutes) {
  const m = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Kdy má dnešní směna skončit (v minutách od půlnoci) – stejné pravidlo jako v appce
function shiftEndMinutes(entry, settings) {
  const dayMinutes = (Number(settings.workDayLength) || 8) * 60;
  const half = !!entry.halfVac;
  const target = half ? dayMinutes / 2 : dayMinutes;
  // u půldne dovolené s krátkou směnou (do 6 h) se přestávka neodečítá
  const skipBreak = half && target <= 360;
  const breakMin = settings.countBreak && !skipBreak ? Number(settings.breakMinutes) || 0 : 0;
  return hmToMinutes(entry.checkIn) + target + breakMin;
}

// Vrátí text upozornění, nebo null, pokud se teď nemá nic posílat
function decide(entry, settings, nowMinutes) {
  if (!settings || !settings.notifyEnabled) return null;
  if (!entry || entry.type !== 'work' || !entry.checkIn || entry.checkOut) return null;

  const end = shiftEndMinutes(entry, settings);
  const lead = Number(settings.notifyMinutes) || 15;
  if (nowMinutes < end - lead) return null;
  if (nowMinutes > end + GRACE_AFTER_END_MIN) return null;

  const left = end - nowMinutes;
  const body = left > 0
    ? `Za ${left} min ti končí směna (${fmtHM(end)}). Nezapomeň zapsat odchod.`
    : `Směna ti skončila v ${fmtHM(end)}. Nezapomeň zapsat odchod.`;
  return { title: 'Docházka', body };
}

// ---------- Google API ----------

async function getAccessToken(sa) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.email === sa.client_email && cachedToken.exp - 120 > nowSec) {
    return cachedToken.value;
  }
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec, exp: nowSec + 3600,
  })));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claim}`)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error(`Přihlášení ke Google API selhalo: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, exp: nowSec + (data.expires_in || 3600), email: sa.client_email };
  return cachedToken.value;
}

function fsBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/dochazka`;
}

async function fsGet(projectId, token, docId) {
  const res = await fetch(`${fsBase(projectId)}/${docId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Čtení ${docId}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fsPatch(projectId, token, docId, field, value) {
  const res = await fetch(`${fsBase(projectId)}/${docId}?updateMask.fieldPaths=${field}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { [field]: value } }),
  });
  if (!res.ok) throw new Error(`Zápis ${docId}.${field}: ${res.status} ${await res.text()}`);
}

function readTokens(pushDoc) {
  const values = pushDoc && pushDoc.fields && pushDoc.fields.tokens && pushDoc.fields.tokens.arrayValue.values;
  return (values || []).map(v => v.stringValue).filter(Boolean);
}

// Pošle jedno upozornění. Vrací 'ok', 'invalid' (token už neplatí) nebo 'error'.
async function sendPush(projectId, token, deviceToken, title, body, appUrl) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title, body },
        webpush: {
          headers: { Urgency: 'high', TTL: '1800' },
          notification: { icon: `${appUrl}icon-192.png` },
          fcm_options: { link: appUrl },
        },
      },
    }),
  });
  if (res.ok) return 'ok';
  const text = await res.text();
  console.error('FCM chyba', res.status, text);
  if (res.status === 404 || (res.status === 400 && /registration token|INVALID_ARGUMENT/i.test(text))) return 'invalid';
  return 'error';
}

// ---------- hlavní logika ----------

async function run(env) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT);
  const projectId = sa.project_id;
  const appUrl = env.APP_URL || DEFAULT_APP_URL;
  const now = pragueNow();

  const token = await getAccessToken(sa);
  const entriesDoc = await fsGet(projectId, token, 'entries');
  if (!entriesDoc) return 'Žádná data.';

  const data = JSON.parse((entriesDoc.fields && entriesDoc.fields.json && entriesDoc.fields.json.stringValue) || '{}');
  const message = decide((data.entries || {})[now.date], data.settings, now.minutes);
  if (!message) return 'Nic k odeslání.';

  const pushDoc = await fsGet(projectId, token, 'push');
  if (pushDoc && pushDoc.fields && pushDoc.fields.lastNotifiedDate && pushDoc.fields.lastNotifiedDate.stringValue === now.date) {
    return 'Dnes už upozornění odešlo.';
  }
  const devices = readTokens(pushDoc);
  if (!devices.length) return 'Žádné zařízení nemá upozornění zapnuté.';

  const alive = [];
  let sent = 0;
  for (const device of devices) {
    const result = await sendPush(projectId, token, device, message.title, message.body, appUrl);
    if (result === 'ok') { sent++; alive.push(device); }
    else if (result === 'error') alive.push(device); // chyba ze strany služby – token si necháme
  }
  if (alive.length !== devices.length) {
    await fsPatch(projectId, token, 'push', 'tokens', { arrayValue: { values: alive.map(t => ({ stringValue: t })) } });
  }
  if (sent > 0) {
    await fsPatch(projectId, token, 'push', 'lastNotifiedDate', { stringValue: now.date });
  }
  return `Odesláno na ${sent} z ${devices.length} zařízení.`;
}

// ---------- denní záloha do Cloudflare KV (nepovinná) ----------

const BACKUP_AFTER_MIN = 2 * 60;   // záloha se dělá po 2:00 pražského času
const BACKUP_KEEP_DAYS = 400;      // potom ji Cloudflare sám smaže
let lastBackupDate = null;         // ať se KV nečte každou minutu

// Uloží kopii dat do KV. Bez navázaného BACKUPS nedělá nic.
async function backup(env, manual = false) {
  if (!env.BACKUPS) return manual ? 'Záloha: Worker nemá navázaný KV namespace BACKUPS.' : null;
  const now = pragueNow();
  let key;
  if (manual) {
    key = `rucni-${now.date}-${fmtHM(now.minutes).replace(':', '')}`;
  } else {
    if (now.minutes < BACKUP_AFTER_MIN || lastBackupDate === now.date) return null;
    key = `zaloha-${now.date}`;
    if (await env.BACKUPS.get(key) !== null) { lastBackupDate = now.date; return null; }
  }
  const sa = JSON.parse(env.SERVICE_ACCOUNT);
  const token = await getAccessToken(sa);
  const doc = await fsGet(sa.project_id, token, 'entries');
  if (!doc) return 'Záloha: dokument s daty neexistuje.';
  const json = doc.fields && doc.fields.json && doc.fields.json.stringValue;
  if (typeof json !== 'string') throw new Error('Záloha: v dokumentu chybí pole json');
  let entries = null;
  try { entries = Object.keys(JSON.parse(json).entries || {}).length; } catch (e) { /* uloží se i poškozená data – kvůli ruční opravě */ }
  await env.BACKUPS.put(key, JSON.stringify({ savedAt: new Date().toISOString(), updateTime: doc.updateTime, entries, json }), {
    expirationTtl: BACKUP_KEEP_DAYS * 86400,
    metadata: { entries },
  });
  if (!manual) lastBackupDate = now.date;
  return `Záloha ${key} uložena (${entries === null ? '?' : entries} záznamů).`;
}

// Ruční test: pošle zkušební upozornění na všechna zapnutá zařízení
async function sendTest(env) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT);
  const appUrl = env.APP_URL || DEFAULT_APP_URL;
  const token = await getAccessToken(sa);
  const devices = readTokens(await fsGet(sa.project_id, token, 'push'));
  if (!devices.length) return 'Žádné zařízení nemá upozornění zapnuté (zapni je v nastavení appky).';
  let ok = 0;
  for (const d of devices) {
    if (await sendPush(sa.project_id, token, d, 'Docházka', 'Zkušební upozornění funguje ✓', appUrl) === 'ok') ok++;
  }
  return `Zkušební upozornění: odesláno ${ok} z ${devices.length}.`;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env).then(r => console.log(r)).catch(e => console.error(e.message || e)));
    ctx.waitUntil(backup(env).then(r => r && console.log(r)).catch(e => console.error('Záloha selhala:', e.message || e)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const admin = env.ADMIN_KEY && url.searchParams.get('key') === env.ADMIN_KEY;
    if (url.pathname === '/test' && admin) {
      try { return new Response(await sendTest(env)); }
      catch (e) { return new Response('Chyba: ' + (e.message || e), { status: 500 }); }
    }
    if (url.pathname === '/backup-now' && admin) {
      try { return new Response(await backup(env, true)); }
      catch (e) { return new Response('Chyba: ' + (e.message || e), { status: 500 }); }
    }
    return new Response('Docházka – odesílač upozornění běží.');
  },
};
