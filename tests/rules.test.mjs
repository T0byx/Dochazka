// Testy pravidel databáze (firestore.rules) proti lokálnímu emulátoru – nikdy proti produkci.
// Spuštění: npm run test:rules
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, collection, getDoc, getDocs, setDoc, deleteDoc, updateDoc, writeBatch, runTransaction,
  serverTimestamp, arrayUnion, arrayRemove, query, orderBy, limit, Timestamp,
} from 'firebase/firestore';

const OWNER = 'mama-uid';
const STRANGER = 'cizi-uid';

// V testech se místo skutečného UID mamky použije testovací OWNER.
const rulesSource = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const testRules = rulesSource.replace(/function ownerUids\(\) \{[^}]*\}/, `function ownerUids() { return ['${OWNER}']; }`);
assert.notEqual(testRules, rulesSource, 've firestore.rules chybí funkce ownerUids()');

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-dochazka',
    firestore: { rules: testRules, host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

// data ve stejném tvaru, jaký ukládá appka: JSON text { entries, settings }
function dataJson(days) {
  const entries = {};
  for (let i = 0; i < days; i++) {
    const key = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    entries[key] = { type: 'work', checkIn: '07:30', checkOut: '16:00' };
  }
  return JSON.stringify({ entries, settings: { workDayLength: 8, countBreak: true, breakMinutes: 30 } });
}

async function seed(path, data) {
  await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), path), data); });
}
async function seedMain(json) { await seed('dochazka/entries', { json, updatedAt: 1 }); }
async function readAsAdmin(path) {
  let snap;
  await env.withSecurityRulesDisabled(async ctx => { snap = await getDoc(doc(ctx.firestore(), path)); });
  return snap;
}

const ownerDb = () => env.authenticatedContext(OWNER).firestore();
const strangerDb = () => env.authenticatedContext(STRANGER).firestore();

// Stejný zápis, jaký dělá appka: předchozí verze do historie + nová data, vše najednou.
function archivedWrite(db, prevJson, newJson, histId = 'h' + Math.random().toString(36).slice(2, 12)) {
  const batch = writeBatch(db);
  batch.set(doc(db, 'dochazka/entries/history', histId), { json: prevJson, savedAt: serverTimestamp(), reason: 'test' });
  batch.set(doc(db, 'dochazka/entries'), { json: newJson, updatedAt: Date.now(), prevHistoryId: histId });
  return batch.commit();
}

describe('kdo se k datům dostane', () => {
  test('nepřihlášený nic nepřečte ani nezapíše', async () => {
    await seedMain(dataJson(3));
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'dochazka/entries')));
    await assertFails(getDoc(doc(db, 'dochazka/push')));
    await assertFails(getDocs(collection(db, 'dochazka/entries/history')));
    await assertFails(setDoc(doc(db, 'dochazka/entries'), { json: '{}', updatedAt: 1 }));
  });

  test('cizí přihlášený účet (třeba nově založený přes API klíč) nic nepřečte, nezmění ani nesmaže', async () => {
    const prev = dataJson(3);
    await seedMain(prev);
    const db = strangerDb();
    await assertFails(getDoc(doc(db, 'dochazka/entries')));
    await assertFails(getDocs(collection(db, 'dochazka/entries/history')));
    await assertFails(deleteDoc(doc(db, 'dochazka/entries')));
    await assertFails(archivedWrite(db, prev, dataJson(4)));
    await assertFails(setDoc(doc(db, 'dochazka/push'), { tokens: ['cizi-telefon'] }));
  });

  test('mamka čte data, historii i push', async () => {
    await seedMain(dataJson(3));
    await seed('dochazka/push', { tokens: ['t1'] });
    const db = ownerDb();
    await assertSucceeds(getDoc(doc(db, 'dochazka/entries')));
    await assertSucceeds(getDoc(doc(db, 'dochazka/push')));
    await assertSucceeds(getDocs(query(collection(db, 'dochazka/entries/history'), orderBy('savedAt', 'desc'), limit(30))));
  });
});

describe('hlavní dokument s daty', () => {
  test('první založení dat projde', async () => {
    await assertSucceeds(setDoc(doc(ownerDb(), 'dochazka/entries'), { json: dataJson(1), updatedAt: Date.now() }));
  });

  test('změna s uložením předchozí verze do historie projde a verze je v historii', async () => {
    const prev = dataJson(10);
    await seedMain(prev);
    await assertSucceeds(archivedWrite(ownerDb(), prev, dataJson(11), 'verze1'));
    assert.equal((await readAsAdmin('dochazka/entries/history/verze1')).data().json, prev);
    assert.equal((await readAsAdmin('dochazka/entries')).data().json, dataJson(11));
  });

  test('stejný zápis jako v appce – transakce – projde', async () => {
    const prev = dataJson(10);
    await seedMain(prev);
    const db = ownerDb();
    const mainRef = doc(db, 'dochazka/entries');
    await assertSucceeds(runTransaction(db, async tx => {
      const snap = await tx.get(mainRef);
      const data = JSON.parse(snap.data().json);
      data.entries['2026-11-17'] = { type: 'sickday' };
      const histRef = doc(collection(db, 'dochazka/entries/history'));
      tx.set(histRef, { json: snap.data().json, savedAt: serverTimestamp(), reason: 'nemoc' });
      tx.set(mainRef, { json: JSON.stringify(data), updatedAt: Date.now(), prevHistoryId: histRef.id });
    }));
  });

  test('přepis BEZ uložení předchozí verze neprojde (např. stará verze appky)', async () => {
    await seedMain(dataJson(10));
    await assertFails(setDoc(doc(ownerDb(), 'dochazka/entries'), { json: dataJson(11), updatedAt: Date.now() }));
  });

  test('do historie se musí uložit přesně ta verze, která se přepisuje', async () => {
    await seedMain(dataJson(10));
    await assertFails(archivedWrite(ownerDb(), dataJson(9), dataJson(11)));
  });

  test('odkaz na neexistující verzi v historii neprojde', async () => {
    await seedMain(dataJson(10));
    await assertFails(setDoc(doc(ownerDb(), 'dochazka/entries'),
      { json: dataJson(11), updatedAt: Date.now(), prevHistoryId: 'neexistuje' }));
  });

  test('hlavní dokument nejde smazat ani mamčiným účtem', async () => {
    await seedMain(dataJson(10));
    await assertFails(deleteDoc(doc(ownerDb(), 'dochazka/entries')));
  });

  test('přepsání plných dat prázdnými neprojde ani s historií', async () => {
    const prev = dataJson(60);
    await seedMain(prev);
    await assertFails(archivedWrite(ownerDb(), prev, JSON.stringify({ entries: {}, settings: {} })));
    assert.equal((await readAsAdmin('dochazka/entries')).data().json, prev);
  });

  test('smazání jednoho dne projde', async () => {
    const prev = dataJson(60);
    await seedMain(prev);
    const next = JSON.parse(prev);
    delete next.entries['2026-01-05'];
    await assertSucceeds(archivedWrite(ownerDb(), prev, JSON.stringify(next)));
  });

  test('nečekaná pole nebo špatné typy neprojdou', async () => {
    const db = ownerDb();
    await assertFails(setDoc(doc(db, 'dochazka/entries'), { json: '{}', updatedAt: 1, admin: true }));
    await assertFails(setDoc(doc(db, 'dochazka/entries'), { json: 123, updatedAt: 1 }));
    await assertFails(setDoc(doc(db, 'dochazka/entries'), { json: '{}' }));
  });
});

describe('historie verzí', () => {
  test('uloženou verzi nejde upravit ani smazat', async () => {
    const prev = dataJson(5);
    await seedMain(prev);
    await archivedWrite(ownerDb(), prev, dataJson(6), 'verze1');
    await assertFails(updateDoc(doc(ownerDb(), 'dochazka/entries/history/verze1'), { json: '{}' }));
    await assertFails(setDoc(doc(ownerDb(), 'dochazka/entries/history/verze1'), { json: '{}', savedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(ownerDb(), 'dochazka/entries/history/verze1')));
  });

  test('samostatný zápis do historie (bez změny dat) neprojde', async () => {
    await seedMain(dataJson(5));
    await assertFails(setDoc(doc(ownerDb(), 'dochazka/entries/history/spam'), { json: 'x', savedAt: serverTimestamp() }));
  });

  test('čas uložení musí dát server, ne telefon', async () => {
    const prev = dataJson(5);
    await seedMain(prev);
    const db = ownerDb();
    const batch = writeBatch(db);
    batch.set(doc(db, 'dochazka/entries/history/verze2'), { json: prev, savedAt: Timestamp.fromMillis(0) });
    batch.set(doc(db, 'dochazka/entries'), { json: dataJson(6), updatedAt: Date.now(), prevHistoryId: 'verze2' });
    await assertFails(batch.commit());
  });
});

describe('telefony pro upozornění (dochazka/push)', () => {
  test('mamka přidá i odebere telefon, záznam Workeru zůstane', async () => {
    await seed('dochazka/push', { tokens: ['t1'], lastNotifiedDate: '2026-11-16' });
    const ref = doc(ownerDb(), 'dochazka/push');
    await assertSucceeds(setDoc(ref, { tokens: arrayUnion('t2') }, { merge: true }));
    await assertSucceeds(setDoc(ref, { tokens: arrayRemove('t1') }, { merge: true }));
    const data = (await readAsAdmin('dochazka/push')).data();
    assert.deepEqual(data.tokens, ['t2']);
    assert.equal(data.lastNotifiedDate, '2026-11-16');
  });

  test('první zapnutí upozornění (dokument ještě neexistuje) projde', async () => {
    await assertSucceeds(setDoc(doc(ownerDb(), 'dochazka/push'), { tokens: arrayUnion('t1') }, { merge: true }));
  });

  test('dokument nejde smazat, nesmí mít cizí pole ani přes 20 telefonů', async () => {
    await seed('dochazka/push', { tokens: ['t1'] });
    const ref = doc(ownerDb(), 'dochazka/push');
    await assertFails(deleteDoc(ref));
    await assertFails(setDoc(ref, { tokens: ['t1'], jine: 1 }));
    await assertFails(setDoc(ref, { tokens: Array.from({ length: 21 }, (_, i) => 't' + i) }));
  });
});

test('jiné kolekce a dokumenty jsou zakázané i pro mamku', async () => {
  const db = ownerDb();
  await assertFails(setDoc(doc(db, 'jine/doc'), { a: 1 }));
  await assertFails(setDoc(doc(db, 'dochazka/jiny'), { a: 1 }));
  await assertFails(getDoc(doc(db, 'dochazka/jiny')));
});
