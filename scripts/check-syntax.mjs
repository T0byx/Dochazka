// Rychlá kontrola před nahráním: appka nemá žádný build, takže jediná chyba v JavaScriptu
// = nefunkční appka v telefonu. Spuštění: npm run check  (nebo: node scripts/check-syntax.mjs)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import vm from 'node:vm';

const root = new URL('..', import.meta.url).pathname;
const problems = [];
const ok = msg => console.log('✓ ' + msg);

// 1) vložené <script> bloky v index.html (jen syntaxe, nic se nespouští)
const html = readFileSync(join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
scripts.forEach((m, i) => {
  const line = html.slice(0, m.index).split('\n').length;
  try { new vm.Script(m[1], { filename: `index.html (skript #${i + 1}, od řádku ${line})` }); }
  catch (e) { problems.push(`index.html – skript #${i + 1} od řádku ${line}: ${e.message}`); }
});
ok(`index.html: ${scripts.length} vložených skriptů`);

// 2) inline obsluhy (onclick="…") s daty z databáze byly zdrojem XSS – nepoužívat
if (/\son[a-z]+\s*=\s*("[^"]*\$\{|'[^']*\$\{)/i.test(html)) problems.push('index.html: inline obsluha (onclick="…${…}") s daty – použij data-* atribut a addEventListener');

// 3) service worker (klasický skript)
try { new vm.Script(readFileSync(join(root, 'sw.js'), 'utf8'), { filename: 'sw.js' }); ok('sw.js'); }
catch (e) { problems.push('sw.js: ' + e.message); }

// 4) Cloudflare Worker a testy (ES moduly)
for (const dir of ['worker', 'tests', 'scripts']) {
  let files = [];
  try { files = readdirSync(join(root, dir)).filter(f => /\.m?js$/.test(f)); } catch { continue; }
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', join(root, dir, f)], { stdio: 'pipe' }); }
    catch (e) { problems.push(`${dir}/${f}: ${String(e.stderr || e.message).trim().split('\n').slice(0, 4).join(' ')}`); }
  }
  ok(`${dir}/: ${files.length} souborů`);
}

// 5) JSON soubory
for (const f of ['manifest.json', 'firebase.json', 'package.json']) {
  try { JSON.parse(readFileSync(join(root, f), 'utf8')); ok(f); }
  catch (e) { problems.push(`${f}: neplatný JSON – ${e.message}`); }
}

// 6) pravidla databáze musí mít seznam vlastníků (testy i nasazení na něm stojí)
const rules = readFileSync(join(root, 'firestore.rules'), 'utf8');
if (!/function ownerUids\(\) \{[^}]*\}/.test(rules)) problems.push('firestore.rules: chybí funkce ownerUids()');
else ok('firestore.rules: ownerUids()');

// 7) do (veřejného!) repozitáře nesmí přijít soukromé klíče ani službový účet
const skip = new Set(['.git', 'node_modules', '.firebase']);
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (st.size > 2_000_000 || /\.(png|jpe?g|gif|ico|woff2?|ttf)$/i.test(name)) continue;
    const text = readFileSync(p, 'utf8');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|"type"\s*:\s*"service_account"/.test(text)) {
      problems.push(`${relative(root, p)}: obsahuje soukromý klíč / službový účet – NIKDY necommitovat (repo je veřejné)`);
    }
  }
})(root);
ok('žádné soukromé klíče v souborech');

if (problems.length) {
  console.error('\n✗ Nalezené problémy:\n' + problems.map(p => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log('\nVše v pořádku.');
