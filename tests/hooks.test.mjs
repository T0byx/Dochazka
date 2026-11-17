// Testy pojistek pro Claude Code (.claude/hooks). Spuštění: npm run test:hooks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = (script, payload, env = {}) => spawnSync(process.execPath, [join(ROOT, '.claude/hooks', script)], {
  input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, ...env },
});
const bash = command => {
  const r = run('guard-bash.mjs', { tool_name: 'Bash', tool_input: { command } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow';
};

test('nevratné příkazy proti produkci a main se zablokují', () => {
  for (const c of [
    'firebase firestore:delete --all-collections --project evidence-dochazky',
    'npx firebase firestore:delete dochazka -r --force',
    "gcloud firestore databases delete --database='(default)'",
    'gcloud projects delete evidence-dochazky',
    'curl -X DELETE "https://firestore.googleapis.com/v1/projects/evidence-dochazky/databases/(default)/documents/dochazka/entries"',
    'curl "https://firestore.googleapis.com/v1/projects/x/databases/(default)/documents/dochazka/push" --request DELETE',
    'npx wrangler kv key delete --binding BACKUPS zaloha-2026-01-01',
    'wrangler kv:namespace delete --namespace-id abc',
    'wrangler delete dochazka-notify',
    'git push --force origin main',
    'git push -f origin HEAD:main',
    'git push origin +main',
    'git push origin --delete main',
  ]) assert.equal(bash(c), 'deny', c);
});

test('nasazení a přepis historie se musí potvrdit', () => {
  for (const c of [
    'npx firebase deploy --only firestore:rules --project evidence-dochazky',
    'firebase deploy',
    'npx wrangler deploy',
    'gcloud firestore import gs://zaloha/2026-01-01',
    'git push --force-with-lease origin claude/nejaka-vetev',
    'git filter-repo --path index.html --invert-paths',
    'curl -s https://firestore.googleapis.com/v1/projects/evidence-dochazky/databases/(default)/documents/dochazka/entries',
  ]) assert.equal(bash(c), 'ask', c);
});

test('běžná práce projde bez zdržení', () => {
  for (const c of [
    'npm test',
    'npm run test:rules',
    'firebase emulators:exec --only firestore --project demo-dochazka "node --test tests/rules.test.mjs"',
    'git push -u origin claude/adoring-albattani-iz8pn5',
    'git status && git log --oneline -5',
    'git checkout main && git pull',
    'node scripts/check-syntax.mjs',
  ]) assert.equal(bash(c), 'allow', c);
});

const mcp = toolName => {
  const r = run('guard-mcp.mjs', { tool_name: toolName, tool_input: {} });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow';
};

test('MCP: mazání a přímé zápisy do produkce se zablokují', () => {
  for (const t of [
    'mcp__plugin_firebase_firebase__firestore_delete_document',
    'mcp__plugin_firebase_firebase__firestore_delete_database',
    'mcp__plugin_firebase_firebase__firestore_delete_backup',
    'mcp__plugin_firebase_firebase__firestore_delete_backup_schedule',
    'mcp__plugin_firebase_firebase__firestore_update_document',
    'mcp__plugin_firebase_firebase__firestore_add_document',
    'mcp__firebase-readonly__firestore_update_document',
    'mcp__plugin_firebase_firebase__auth_update_user',
    'mcp__plugin_firebase_firebase__auth_set_sms_region_policy',
    'mcp__Cloudflare_Developer_Platform__kv_namespace_delete',
    'mcp__Cloudflare_Developer_Platform__r2_bucket_delete',
    'mcp__Cloudflare_Developer_Platform__d1_database_delete',
  ]) assert.equal(mcp(t), 'deny', t);
});

test('MCP: nasazení a vytváření se musí potvrdit, čtení projde', () => {
  for (const t of [
    'mcp__plugin_firebase_firebase__firebase_deploy',
    'mcp__plugin_firebase_firebase__firestore_create_backup_schedule',
    'mcp__plugin_firebase_firebase__firestore_update_database',
    'mcp__Cloudflare_Developer_Platform__kv_namespace_create',
    'mcp__Cloudflare_Developer_Platform__kv_namespace_update',
  ]) assert.equal(mcp(t), 'ask', t);
  for (const t of [
    'mcp__plugin_firebase_firebase__firebase_get_security_rules',
    'mcp__plugin_firebase_firebase__firestore_get_document',
    'mcp__plugin_firebase_firebase__firestore_query_collection',
    'mcp__plugin_firebase_firebase__auth_get_users',
    'mcp__plugin_firebase_firebase__firebase_update_environment',
    'mcp__plugin_firebase_firebase__firebase_login',
    'mcp__Cloudflare_Developer_Platform__workers_get_worker_code',
    'mcp__Cloudflare_Developer_Platform__kv_namespaces_list',
    'mcp__github__get_file_contents',
    'mcp__github__delete_file',
    'Bash',
  ]) assert.equal(mcp(t), 'allow', t);
});

test('kontrola po úpravě: nesouvisející soubor ignoruje, pravidla a sw.js připomene', () => {
  let r = run('after-edit.mjs', { tool_name: 'Edit', tool_input: { file_path: join(ROOT, 'CLAUDE.md') } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');

  r = run('after-edit.mjs', { tool_name: 'Edit', tool_input: { file_path: join(ROOT, 'index.html') } });
  assert.equal(r.status, 0, r.stderr);

  r = run('after-edit.mjs', { tool_name: 'Write', tool_input: { file_path: join(ROOT, 'firestore.rules') } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /test:rules/);
});

test('kontrola po úpravě: chyba v JavaScriptu vrátí kód 2 s popisem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dochazka-hook-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    for (const f of ['index.html', 'manifest.json', 'firebase.json', 'package.json', 'firestore.rules', 'scripts/check-syntax.mjs']) {
      copyFileSync(join(ROOT, f), join(dir, f));
    }
    writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", e => {');
    const r = run('after-edit.mjs', { tool_name: 'Edit', tool_input: { file_path: join(dir, 'sw.js') } }, { CLAUDE_PROJECT_DIR: dir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /sw\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
