#!/usr/bin/env node
// PreToolUse hook (MCP nástroje) – pojistka pro konektory Firebase a Cloudflare.
// Přímý zápis do produkční databáze přes MCP obchází historii verzí z appky (MCP běží
// s právy správce, pravidla databáze na něj neplatí) a mazání je nevratné.
//   - mazání čehokoli (dokumenty, databáze, zálohy, KV, Workery…)       → zablokovat
//   - přímý zápis dokumentů / uživatelů ve Firebase                      → zablokovat
//   - nasazení, vytváření a úpravy (pravidla, plány záloh, KV…)          → zeptat se
//   - čtení                                                              → povolit
// Testy: tests/hooks.test.mjs
import { readFileSync } from 'node:fs';

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const m = /^mcp__(.+?)__(.+)$/.exec(String(input?.tool_name || ''));
if (!m) process.exit(0);
const server = m[1].toLowerCase();
const tool = m[2].toLowerCase();
const firebase = server.includes('firebase');
const cloudflare = server.includes('cloudflare');
if (!firebase && !cloudflare) process.exit(0);

// názvy nástrojů jsou snake_case → porovnávají se celá slova (ne „put“ v „input“)
const words = tool.split(/[_\-.]+/);
const has = (...list) => list.some(w => words.includes(w));

function decide(permissionDecision, permissionDecisionReason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } }));
  process.exit(0);
}

if (has('delete', 'remove', 'purge', 'destroy', 'drop')) {
  decide('deny', `Zablokováno ochranou dat (.claude/hooks/guard-mcp.mjs): ${tool} je nevratné mazání v produkci. Tohle smí udělat jen člověk sám v konzoli.`);
}
const directWrite = firebase && (
  (words.includes('document') && has('add', 'update', 'set', 'patch')) ||
  (words[0] === 'auth' && has('update', 'set', 'disable', 'import')) ||
  (words[0] === 'realtimedatabase' && has('set', 'update', 'push'))
);
if (directWrite) {
  decide('deny', `Zablokováno ochranou dat (.claude/hooks/guard-mcp.mjs): ${tool} by zapsal přímo do produkce mimo appku a obešel historii verzí. Data se mění jen v appce (nebo ručně v konzoli).`);
}
if (has('deploy', 'create', 'update', 'put', 'edit', 'publish', 'init', 'import', 'set', 'patch', 'rollback') && tool !== 'firebase_update_environment') {
  decide('ask', `Pozor – ${tool} mění produkční prostředí (${firebase ? 'Firebase evidence-dochazky' : 'Cloudflare'}). Spusť jen po výslovném souhlasu.`);
}
process.exit(0);
