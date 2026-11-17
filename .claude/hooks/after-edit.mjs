#!/usr/bin/env node
// PostToolUse hook (Edit/Write) – po každé úpravě souborů appky spustí rychlou kontrolu
// (scripts/check-syntax.mjs). Appka nemá build, takže chyba v JS = rozbitá appka v telefonu.
// Při chybě vrátí kód 2 → Claude chybu uvidí a opraví ji.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const file = String(input?.tool_input?.file_path || input?.tool_response?.filePath || '').replace(/\\/g, '/');
const relevant = /(^|\/)(index\.html|sw\.js|manifest\.json|firebase\.json|package\.json|firestore\.rules|\.mcp\.json|settings\.json)$/.test(file)
  || /(^|\/)(worker|tests|scripts|hooks)\/[^/]+\.m?js$/.test(file);
if (!relevant) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const r = spawnSync(process.execPath, [join(root, 'scripts', 'check-syntax.mjs')], { cwd: root, encoding: 'utf8' });

const notes = [];
if (/firestore\.rules$/.test(file)) notes.push('Změnila se pravidla databáze: spusť `npm run test:rules`. Nasazuje je člověk ručně, až po nasazení appky (viz ZABEZPECENI.md).');
if (/sw\.js$/.test(file)) notes.push('Změnil se service worker: zvyš verzi CACHE v sw.js, ať si telefony stáhnou novou verzi.');

if (r.status !== 0) {
  process.stderr.write(`Kontrola po úpravě selhala (npm run check):\n${r.stdout || ''}${r.stderr || ''}\n${notes.join('\n')}\n`);
  process.exit(2);
}
if (notes.length) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join('\n') } }));
}
process.exit(0);
