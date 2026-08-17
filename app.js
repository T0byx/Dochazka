// ============================================================
// Přihlášení (jednoduchá klientská ochrana - ne skutečné zabezpečení,
// heslo je čitelné ve zdrojovém kódu appky)
// ============================================================
const AUTH_USER = 'lucka';
const AUTH_PASS = 'Emicka2020';

function isAuthed() {
  return localStorage.getItem('dochazka_auth') === '1' || sessionStorage.getItem('dochazka_auth') === '1';
}
function showApp() { document.getElementById('loginOverlay').style.display = 'none'; }
if (isAuthed()) showApp();

const EYE_OPEN = `<path d="M1.5 12s3.9-7 10.5-7 10.5 7 10.5 7-3.9 7-10.5 7S1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/>`;
const EYE_OFF = `<path d="M3 3l18 18"/><path d="M10.6 5.2C11 5.1 11.5 5 12 5c6.6 0 10.5 7 10.5 7a13.2 13.2 0 0 1-3.1 3.9M6.2 6.6C3.4 8.3 1.5 12 1.5 12s3.9 7 10.5 7c1.7 0 3.2-.4 4.5-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>`;

document.getElementById('togglePass').addEventListener('click', () => {
  const input = document.getElementById('loginPass');
  const icon = document.getElementById('eyeIcon');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  icon.innerHTML = show ? EYE_OFF : EYE_OPEN;
});

function attemptLogin() {
  const u = document.getElementById('loginUser').value.trim().toLowerCase();
  const p = document.getElementById('loginPass').value;
  if (u === AUTH_USER && p === AUTH_PASS) {
    if (document.getElementById('loginRemember').checked) localStorage.setItem('dochazka_auth', '1');
    else sessionStorage.setItem('dochazka_auth', '1');
    document.getElementById('loginError').textContent = '';
    showApp();
  } else {
    document.getElementById('loginError').textContent = 'Špatné jméno nebo heslo.';
  }
}
document.getElementById('loginBtn').addEventListener('click', attemptLogin);
document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });

document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('dochazka_auth');
  sessionStorage.removeItem('dochazka_auth');
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginOverlay').style.display = 'flex';
});

// ============================================================
// Téma (světlý / tmavý režim)
// ============================================================
const themeBtn = document.getElementById('themeToggle');
function applyTheme(t) {
  document.body.classList.toggle('dark', t === 'dark');
  localStorage.setItem('dochazka_theme', t);
  themeBtn.textContent = t === 'dark' ? '☀️' : '🌙';
}
applyTheme(localStorage.getItem('dochazka_theme') || 'light');
themeBtn.addEventListener('click', () => {
  applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark');
});

// ============================================================
// Firebase konfigurace (evidence-dochazky projekt)
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyCXeJSAeej49YIODneqfTuI9eT4u9QlmN0",
  authDomain: "evidence-dochazky.firebaseapp.com",
  projectId: "evidence-dochazky",
  storageBucket: "evidence-dochazky.firebasestorage.app",
  messagingSenderId: "698522546437",
  appId: "1:698522546437:web:93b605318baf8a0b7ec76c"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const docRef = db.collection('dochazka').doc('entries');

// ============================================================
// Typy záznamů
// ============================================================
const TYPES = {
  sickday:   { label: 'Sickday',          emoji: '🌡️', color: '#BB4430', bg: 'rgba(187,68,48,0.12)' },
  dovolena:  { label: 'Dovolená',         emoji: '🌴', color: '#2E8574', bg: 'rgba(46,133,116,0.12)' },
  neplacene: { label: 'Neplacené volno',  emoji: '🌙', color: '#7A5C8E', bg: 'rgba(122,92,142,0.12)' },
  doktor:    { label: 'Doktor',           emoji: '🩺', color: '#4C6FA0', bg: 'rgba(76,111,160,0.12)' },
  svatek:    { label: 'Státní svátek',    emoji: '🎌', color: '#B06B2C', bg: 'rgba(176,107,44,0.12)' },
};

const MONTHS = ['leden','únor','březen','duben','květen','červen','červenec','srpen','září','říjen','listopad','prosinec'];
const WEEKDAYS_SHORT = ['po','út','st','čt','pá','so','ne'];

let year = new Date().getFullYear();
let month = new Date().getMonth();
let entries = {};
let settings = { vacationDaysTotal: 20, sickDaysTotal: 5, workDayLength: 8, countBreak: true, breakMinutes: 30 };
let openDayKey = null;
let sheetStep = 'view'; // 'pickdate' | 'view' | 'choose' | 'time'
let pendingAction = null; // 'checkIn' | 'checkOut'

function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }
function weekdayIdxFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return wd === 0 ? 6 : wd - 1;
}
function todayISO() {
  const t = new Date();
  return isoDate(t.getFullYear(), t.getMonth(), t.getDate());
}
function isoWeek(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((date - firstThursday) / (7 * 86400000));
}

function spanMinutes(inT, outT) {
  const [ih, im] = inT.split(':').map(Number);
  const [oh, om] = outT.split(':').map(Number);
  let mins = (oh * 60 + om) - (ih * 60 + im);
  if (mins < 0) mins += 24 * 60;
  return mins;
}
function fmtDur(hoursFloat) {
  const totalMin = Math.round(Math.abs(hoursFloat) * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${pad(m)}`;
}
function fmtSaldo(h) {
  if (h === null) return '–';
  const sign = h < -0.0001 ? '−' : (h > 0.0001 ? '+' : '');
  return sign + fmtDur(h);
}

function workedHours(entry) {
  if (!entry || entry.type !== 'work' || !entry.checkIn || !entry.checkOut) return null;
  let mins = spanMinutes(entry.checkIn, entry.checkOut);
  if (settings.countBreak) mins -= (Number(settings.breakMinutes) || 0);
  if (mins < 0) mins = 0;
  return mins / 60;
}
function daySaldo(entry) {
  const wh = workedHours(entry);
  if (wh === null) return null;
  return wh - Number(settings.workDayLength);
}

// ============================================================
// Firestore load + realtime sync
// ============================================================
function setStatus(text) { document.getElementById('status').textContent = text; }

docRef.onSnapshot(snap => {
  if (snap.exists) {
    try {
      const data = JSON.parse(snap.data().json || '{}');
      entries = data.entries || {};
      settings = Object.assign({}, settings, data.settings || {});
    } catch (e) { entries = {}; }
  }
  render();
  if (openDayKey || sheetStep === 'pickdate') renderSheet();
}, err => {
  setStatus('Chyba připojení k databázi');
  console.error(err);
});

async function persist() {
  setStatus('Ukládám…');
  try {
    await docRef.set({ json: JSON.stringify({ entries, settings }), updatedAt: Date.now() });
    setStatus('Uloženo');
    setTimeout(() => setStatus(''), 1200);
  } catch (e) {
    setStatus('Uložení se nezdařilo');
    console.error(e);
  }
}

function setEntry(dateKey, patch) {
  if (patch === null) delete entries[dateKey];
  else entries[dateKey] = patch;
  persist();
  render();
}

// ============================================================
// Render: summary + table (jen dny, které mají záznam)
// ============================================================
function render() {
  document.getElementById('monthLabel').textContent = `${MONTHS[month]} ${year}`;

  const prefix = `${year}-${pad(month + 1)}-`;
  const monthKeys = Object.keys(entries).filter(k => k.startsWith(prefix)).sort();

  let totalHours = 0, totalSaldo = 0;
  monthKeys.forEach(key => {
    const e = entries[key];
    const wh = workedHours(e);
    if (wh !== null) { totalHours += wh; totalSaldo += daySaldo(e); }
  });

  document.getElementById('totalHours').textContent = fmtDur(totalHours);
  const saldoEl = document.getElementById('totalSaldo');
  saldoEl.textContent = fmtSaldo(totalSaldo);
  saldoEl.className = 'saldo-val mono ' + (totalSaldo > 0.0001 ? 'saldo-pos' : totalSaldo < -0.0001 ? 'saldo-neg' : 'saldo-zero');

  // Year-wide quota usage
  let vacUsed = 0, sickUsed = 0;
  Object.keys(entries).forEach(key => {
    if (!key.startsWith(String(year) + '-')) return;
    const t = entries[key].type;
    if (t === 'dovolena') vacUsed++;
    if (t === 'sickday') sickUsed++;
  });
  document.getElementById('vacLeft').textContent = `${Math.max(0, settings.vacationDaysTotal - vacUsed)} / ${settings.vacationDaysTotal} dní`;
  document.getElementById('sickLeft').textContent = `${Math.max(0, settings.sickDaysTotal - sickUsed)} / ${settings.sickDaysTotal} dní`;

  // Week cards
  const container = document.getElementById('weeksContainer');
  const emptyState = document.getElementById('emptyState');
  container.innerHTML = '';

  if (monthKeys.length === 0) {
    emptyState.style.display = 'block';
    emptyState.innerHTML = 'Zatím žádné záznamy tento měsíc.<br>Přidej první přes tlačítko „+ Přidat den".';
    return;
  }
  emptyState.style.display = 'none';

  const todayKey = todayISO();
  let rowIdx = 0;

  // group keys by ISO week, preserving chronological order
  const weeks = [];
  monthKeys.forEach(key => {
    const wk = isoWeek(key);
    let group = weeks.find(g => g.wk === wk);
    if (!group) { group = { wk, keys: [] }; weeks.push(group); }
    group.keys.push(key);
  });

  weeks.forEach(group => {
    let wHours = 0, wSaldo = 0;
    group.keys.forEach(k => {
      const wh = workedHours(entries[k]);
      if (wh !== null) { wHours += wh; wSaldo += daySaldo(entries[k]); }
    });
    const saldoClass = wSaldo > 0.0001 ? 'saldo-pos' : wSaldo < -0.0001 ? 'saldo-neg' : 'saldo-zero';

    const card = document.createElement('div');
    card.className = 'week-card';
    card.innerHTML = `<div class="week-card-head"><span class="wk-label">${group.wk}. týden</span><span class="wk-stats mono"><span>${fmtDur(wHours)}</span><span class="${saldoClass}">${fmtSaldo(wSaldo)}</span></span></div>`;

    const table = document.createElement('table');
    table.className = 'dtable';
    table.innerHTML = '<colgroup><col style="width:20%"><col style="width:20%"><col style="width:20%"><col style="width:20%"><col style="width:20%"></colgroup>';
    const tbody = document.createElement('tbody');

    group.keys.forEach(key => {
      const d = Number(key.split('-')[2]);
      const wIdx = weekdayIdxFromKey(key);
      const isWeekend = wIdx >= 5;
      const e = entries[key];
      const tr = document.createElement('tr');
      tr.className = (isWeekend ? 'weekend ' : '') + (key === todayKey ? 'today ' : '') + (rowIdx % 2 === 1 ? 'row-alt' : '');
      rowIdx++;
      tr.addEventListener('click', () => openSheet(key));

      const accentColor = e && e.type && e.type !== 'work' ? TYPES[e.type].color : (e && e.type === 'work' ? 'var(--accent)' : 'transparent');
      const dateTd = document.createElement('td');
      dateTd.innerHTML = `<div class="datecell" style="border-left-color:${accentColor};"><span class="num mono">${d}.</span><span class="wd">${WEEKDAYS_SHORT[wIdx]}</span></div>`;
      tr.appendChild(dateTd);

      if (e && e.type && e.type !== 'work') {
        const cat = TYPES[e.type];
        const td = document.createElement('td');
        td.colSpan = 4;
        td.className = 'ctr';
        td.innerHTML = `<span class="badge" style="background:${cat.bg};color:${cat.color};">${cat.emoji} ${cat.label}</span>`;
        tr.appendChild(td);
      } else {
        const inTd = document.createElement('td'); inTd.className = 'mono nowrap ctr';
        inTd.innerHTML = e?.checkIn ? e.checkIn : '<span class="cell-dash">–</span>';
        const outTd = document.createElement('td'); outTd.className = 'mono nowrap ctr';
        outTd.innerHTML = e?.checkOut ? e.checkOut : '<span class="cell-dash">–</span>';
        const wh = workedHours(e);
        const workTd = document.createElement('td'); workTd.className = 'mono nowrap ctr';
        workTd.innerHTML = wh !== null ? `<span class="work-val">${fmtDur(wh)}</span>` : '<span class="cell-dash">–</span>';
        const sal = daySaldo(e);
        const salTd = document.createElement('td'); salTd.className = 'mono nowrap ctr';
        if (sal === null) salTd.innerHTML = '<span class="cell-dash">–</span>';
        else {
          const cls = sal > 0.0001 ? 'saldo-pos' : sal < -0.0001 ? 'saldo-neg' : 'saldo-zero';
          const bg = sal > 0.0001 ? 'var(--pos-bg)' : sal < -0.0001 ? 'var(--neg-bg)' : 'var(--surface-alt)';
          salTd.innerHTML = `<span class="saldo-chip ${cls}" style="background:${bg};">${fmtSaldo(sal)}</span>`;
        }
        tr.appendChild(inTd); tr.appendChild(outTd); tr.appendChild(workTd); tr.appendChild(salTd);
      }
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    card.appendChild(table);
    container.appendChild(card);
  });
}

// ============================================================
// Day sheet
// ============================================================
function openSheet(key) {
  openDayKey = key;
  sheetStep = 'view';
  document.getElementById('overlay').classList.add('open');
  renderSheet();
}
function openAddSheet() {
  openDayKey = null;
  sheetStep = 'pickdate';
  document.getElementById('overlay').classList.add('open');
  renderSheet();
}
function closeSheet() {
  openDayKey = null;
  sheetStep = 'view';
  document.getElementById('overlay').classList.remove('open');
}

function renderSheet() {
  const body = document.getElementById('sheetBody');

  if (sheetStep === 'pickdate') {
    document.getElementById('sheetTitle').textContent = 'Přidat den';
    body.innerHTML = `
      <div class="field">
        <label>Datum</label>
        <input type="date" id="pickDateInput" value="${todayISO()}" />
      </div>
      <button class="primary-btn" id="pickDateGo">Pokračovat</button>
    `;
    document.getElementById('pickDateGo').addEventListener('click', () => {
      const val = document.getElementById('pickDateInput').value;
      if (!val) return;
      openDayKey = val;
      sheetStep = entries[val] ? 'view' : 'choose';
      renderSheet();
    });
    return;
  }

  const [y, m, d] = openDayKey.split('-').map(Number);
  const weekdayNames = ['neděle','pondělí','úterý','středa','čtvrtek','pátek','sobota'];
  document.getElementById('sheetTitle').textContent = `${d}. den — ${weekdayNames[new Date(y, m - 1, d).getDay()]}`;

  const entry = entries[openDayKey];

  if (sheetStep === 'time') {
    const isCheckIn = pendingAction === 'checkIn';
    const existing = entry && entry[pendingAction];
    const now = new Date();
    const defaultVal = existing || `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    body.innerHTML = `
      <div class="timefield">
        <label>${isCheckIn ? 'Čas příchodu' : 'Čas odchodu'}</label>
        <input type="time" id="timeInput" value="${defaultVal}" />
      </div>
      <div class="btnrow">
        <button class="btn-cancel" id="cancelTime">Zrušit</button>
        <button class="btn-save" id="saveTime">Uložit</button>
      </div>
    `;
    document.getElementById('cancelTime').addEventListener('click', () => { sheetStep = 'choose'; renderSheet(); });
    document.getElementById('saveTime').addEventListener('click', () => {
      const val = document.getElementById('timeInput').value;
      if (!val) return;
      const next = Object.assign({}, entry && entry.type === 'work' ? entry : {}, { type: 'work' });
      next[pendingAction] = val;
      setEntry(openDayKey, next);
      sheetStep = 'view';
      renderSheet();
    });
    return;
  }

  if (sheetStep === 'choose') {
    const order = ['checkIn', 'checkOut', 'sickday', 'dovolena', 'neplacene', 'doktor', 'svatek'];
    const labels = { checkIn: ['🟢','Příchod'], checkOut: ['🔴','Odchod'] };
    let html = '<div class="choice-list">';
    order.forEach(key => {
      if (key === 'checkIn' || key === 'checkOut') {
        html += `<button class="choice-btn" data-action="${key}"><span class="em">${labels[key][0]}</span>${labels[key][1]}</button>`;
      } else {
        const t = TYPES[key];
        html += `<button class="choice-btn" data-type="${key}"><span class="em">${t.emoji}</span>${t.label}</button>`;
      }
    });
    html += '</div>';
    html += '<button class="linkbtn" id="backToView">Zpět</button>';
    body.innerHTML = html;

    body.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => { pendingAction = btn.dataset.action; sheetStep = 'time'; renderSheet(); });
    });
    body.querySelectorAll('[data-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        setEntry(openDayKey, { type: btn.dataset.type });
        sheetStep = 'view';
        renderSheet();
      });
    });
    document.getElementById('backToView').addEventListener('click', () => {
      sheetStep = entries[openDayKey] ? 'view' : 'pickdate';
      renderSheet();
    });
    return;
  }

  // view mode
  let html = '';
  if (entry && entry.type && entry.type !== 'work') {
    const cat = TYPES[entry.type];
    html += `<div class="status-line"><span class="badge" style="background:${cat.bg};color:${cat.color};">${cat.emoji} ${cat.label}</span></div>`;
  } else {
    html += `<div class="status-line"><span class="lbl">Příchod</span><span class="mono">${entry?.checkIn || '–'}</span></div>`;
    html += `<div class="status-line"><span class="lbl">Odchod</span><span class="mono">${entry?.checkOut || '–'}</span></div>`;
    const wh = workedHours(entry);
    if (wh !== null) {
      const sal = daySaldo(entry);
      html += `<div class="divider"></div>`;
      html += `<div class="status-line"><span class="lbl">Odpracováno</span><span class="mono">${fmtDur(wh)}</span></div>`;
      html += `<div class="status-line"><span class="lbl">Saldo</span><span class="mono ${sal > 0.0001 ? 'saldo-pos' : sal < -0.0001 ? 'saldo-neg' : 'saldo-zero'}">${fmtSaldo(sal)}</span></div>`;
    }
  }
  html += `<button class="primary-btn" id="addBtn">+ Přidat / upravit záznam</button>`;
  if (entry) html += `<button class="linkbtn danger" id="clearBtn">Smazat celý den</button>`;
  body.innerHTML = html;

  document.getElementById('addBtn').addEventListener('click', () => { sheetStep = 'choose'; renderSheet(); });
  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => { setEntry(openDayKey, null); closeSheet(); });
}

// ============================================================
// Settings sheet
// ============================================================
function openSettings() {
  document.getElementById('setVacation').value = settings.vacationDaysTotal;
  document.getElementById('setSickdays').value = settings.sickDaysTotal;
  document.getElementById('setWorkLen').value = settings.workDayLength;
  document.getElementById('setCountBreak').checked = !!settings.countBreak;
  document.getElementById('setBreakMin').value = settings.breakMinutes;
  document.getElementById('settingsOverlay').classList.add('open');
}
function closeSettings() { document.getElementById('settingsOverlay').classList.remove('open'); }

document.getElementById('openSettings').addEventListener('click', openSettings);
document.getElementById('closeSettings').addEventListener('click', closeSettings);
document.getElementById('settingsOverlay').addEventListener('click', e => {
  if (e.target.id === 'settingsOverlay') closeSettings();
});
document.getElementById('saveSettings').addEventListener('click', () => {
  settings = {
    vacationDaysTotal: Number(document.getElementById('setVacation').value) || 0,
    sickDaysTotal: Number(document.getElementById('setSickdays').value) || 0,
    workDayLength: Number(document.getElementById('setWorkLen').value) || 8,
    countBreak: document.getElementById('setCountBreak').checked,
    breakMinutes: Number(document.getElementById('setBreakMin').value) || 0,
  };
  persist();
  render();
  closeSettings();
});

// ============================================================
// Navigace a init
// ============================================================
document.getElementById('prevMonth').addEventListener('click', () => {
  month -= 1; if (month < 0) { month = 11; year -= 1; } render();
});
document.getElementById('nextMonth').addEventListener('click', () => {
  month += 1; if (month > 11) { month = 0; year += 1; } render();
});
document.getElementById('addDayBtn').addEventListener('click', openAddSheet);
document.getElementById('closeSheet').addEventListener('click', closeSheet);
document.getElementById('overlay').addEventListener('click', e => {
  if (e.target.id === 'overlay') closeSheet();
});

render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
