#!/usr/bin/env node
// PreToolUse hook (Bash) – pojistka pro Claude Code: nedovolí nevratné příkazy proti
// produkčním datům mamky (Firebase projekt evidence-dochazky, Cloudflare KV se zálohami)
// ani přepis historie větve main, ze které běží appka. U nasazení se vždy zeptá.
// Testy: tests/hooks.test.mjs
import { readFileSync } from 'node:fs';

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const cmd = String(input?.tool_input?.command || '').replace(/\s+/g, ' ');

// [regex, důvod] – [^|;&]* drží shodu uvnitř jednoho příkazu (ne přes && nebo |)
const DENY = [
  [/\bfirebase\b[^|;&]*\bfirestore:(delete|databases:delete)\b/i, 'mazání dat ve Firestore'],
  [/\bfirebase\b[^|;&]*\bdatabase:(remove|set)\b/i, 'mazání / přepis Realtime Database'],
  [/\bgcloud\b[^|;&]*\bfirestore\b[^|;&]*\bdelete\b/i, 'mazání ve Firestore přes gcloud'],
  [/\bgcloud\b[^|;&]*\bprojects\b[^|;&]*\bdelete\b/i, 'smazání celého Google Cloud projektu'],
  [/\b(curl|wget|xh|http|https)\b[^|;&]*(-X ?DELETE|--request[ =]DELETE)[^|;&]*firestore\.googleapis\.com/i, 'DELETE na produkční Firestore API'],
  [/\b(curl|wget|xh|http|https)\b[^|;&]*firestore\.googleapis\.com[^|;&]*(-X ?DELETE|--request[ =]DELETE)/i, 'DELETE na produkční Firestore API'],
  [/\bwrangler\b[^|;&]*\b(kv[: ](key|bulk|namespace)[ :]delete|r2 (object|bucket) delete|delete)\b/i, 'mazání ve Cloudflare (Worker nebo KV se zálohami)'],
  [/\bgit\b[^|;&]*\bpush\b(?=[^|;&]*(--force\b|--force-with-lease|\s-f\b|\s\+[\w/-]+))(?=[^|;&]*\b(main|master)\b)/i, 'force push do main (z main běží appka mamky)'],
  [/\bgit\b[^|;&]*\bpush\b[^|;&]*(--delete\b|\s-d\b|\s:(main|master)\b)[^|;&]*\b(main|master)\b/i, 'smazání větve main'],
];

const ASK = [
  [/\bfirebase\b[^|;&]*\bdeploy\b/i, 'nasazení do produkčního Firebase projektu (pravidla databáze apod.)'],
  [/\bgcloud\b[^|;&]*\bfirestore\b[^|;&]*\bimport\b/i, 'import do Firestore přepíše produkční data'],
  [/\bwrangler\b[^|;&]*\b(deploy|publish|rollback|secret (put|delete))\b/i, 'změna Cloudflare Workeru, který posílá upozornění a dělá zálohy'],
  [/\b(curl|wget|xh)\b[^|;&]*firestore\.googleapis\.com/i, 'přímé volání produkčního Firestore API'],
  [/\bgit\b[^|;&]*\b(filter-branch|filter-repo)\b|\bbfg\b/i, 'přepis historie gitu'],
  [/\bgit\b[^|;&]*\bpush\b[^|;&]*(--force\b|--force-with-lease|\s-f\b)/i, 'force push'],
];

function decide(permissionDecision, permissionDecisionReason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } }));
  process.exit(0);
}

for (const [re, why] of DENY) {
  if (re.test(cmd)) decide('deny', `Zablokováno ochranou dat (.claude/hooks/guard-bash.mjs): ${why}. Tohle smí udělat jen člověk sám, ručně a vědomě.`);
}
for (const [re, why] of ASK) {
  if (re.test(cmd)) decide('ask', `Pozor – ${why}. Spusť jen po výslovném souhlasu (viz CLAUDE.md a ZABEZPECENI.md).`);
}
process.exit(0);
