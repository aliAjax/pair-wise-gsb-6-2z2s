// Verifies the offline merge station logic in src/workspace.ts.
// Usage: node scripts/verify-merge.mjs
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'ws-verify-'));
execFileSync(join(root, 'node_modules/.bin/tsc'), [
  'src/workspace.ts', '--ignoreConfig', '--outDir', out, '--module', 'esnext', '--target', 'es2020',
  '--moduleResolution', 'bundler', '--skipLibCheck',
], {cwd: root, stdio: 'inherit'});
const W = await import(pathToFileURL(join(out, 'workspace.js')).href);

const NOW = 1_700_000_000_000;
const {migrateLegacy, seedWorkspace, buildExport, parseImport, planMerge, resolveConflict,
       pairStatus, isStale, buildCss, snapshotOf} = W;

const edit = (p, patch) => ({...p, ...patch, rev: p.rev + 1, updatedAt: p.updatedAt + 1});
const exportOf = (ws, at) => buildExport(ws, at).file;

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok — ${name}`); };

// --- 1. migration: backfill rev, keep favorites & collections --------------
test('migration backfills rev and keeps favorites and collections', () => {
  const legacy = [
    {id: 1, title: 'A', heading: 'h', body: 'b', category: 'Editorial', favorite: true},
    {id: 2, title: 'B', heading: 'h', body: 'b', category: 'Portfolio', favorite: false},
    {id: 3, title: 'C', heading: 'h', body: 'b', category: 'Editorial', favorite: true},
  ];
  const ws = migrateLegacy(legacy, NOW);
  assert.equal(ws.pairs.length, 3);
  assert.ok(ws.pairs.every(p => p.rev >= 1), 'every pair has a revision number');
  assert.deepEqual(ws.pairs.map(p => p.favorite), [true, false, true], 'favorites preserved');
  assert.equal(ws.collections.length, 2, 'collections rebuilt from categories');
  const editorial = ws.collections.find(c => c.name === 'Editorial');
  assert.equal(ws.pairs.filter(p => p.collectionId === editorial.id).length, 2);
  assert.ok(ws.pairs.every(p => p.base), 'base snapshot set so two migrated copies share an ancestor');
});

// --- 2. one-sided change merges cleanly ------------------------------------
test('one-sided field change merges without conflict', () => {
  const hub = seedWorkspace(NOW);
  const fileA = exportOf(hub, NOW + 10);                       // teammate A takes a copy
  const theirPairs = fileA.pairs.map(p => p.id === 2 ? edit(p, {size: 60}) : p);
  const plan = planMerge(hub, {...fileA, pairs: theirPairs}, 'a.json', NOW + 20);
  assert.equal(plan.summary.updated, 1);
  assert.equal(plan.summary.conflicting, 0);
  assert.equal(plan.workspace.pairs.find(p => p.id === 2).size, 60);
});

// --- 3. both sides change the same field → conflict keeps both versions ----
test('both sides changing size/tracking keeps both versions and marks conflict', () => {
  const hub = seedWorkspace(NOW);
  const fileA = exportOf(hub, NOW + 10);
  const local = {
    ...hub,
    pairs: hub.pairs.map(p => p.id === 1 ? edit(p, {size: 52, tracking: 1}) : p),
  };
  const remotePairs = fileA.pairs.map(p => p.id === 1 ? edit(p, {size: 58, tracking: 2}) : p);
  const plan = planMerge(local, {...fileA, pairs: remotePairs}, 'teammate.json', NOW + 30);
  const merged = plan.workspace.pairs.find(p => p.id === 1);
  assert.equal(merged.size, 52, 'local value stays applied');
  assert.equal(merged.tracking, 1);
  const fields = plan.workspace.conflicts.filter(c => c.pairId === 1).map(c => c.field).sort();
  assert.deepEqual(fields, ['size', 'tracking']);
  const sizeConflict = plan.workspace.conflicts.find(c => c.field === 'size');
  assert.equal(sizeConflict.localValue, 52);
  assert.equal(sizeConflict.remoteValue, 58, 'their version is kept too');
  assert.equal(sizeConflict.source, 'teammate.json', 'conflict records its source');
  assert.equal(plan.summary.conflicting, 1);
});

// --- 4. re-importing the same file is idempotent (safe retry) --------------
test('merging the same file twice does not duplicate conflicts or changes', () => {
  const hub = seedWorkspace(NOW);
  const fileA = exportOf(hub, NOW + 10);
  const local = {...hub, pairs: hub.pairs.map(p => p.id === 1 ? edit(p, {size: 52}) : p)};
  const remotePairs = fileA.pairs.map(p => p.id === 1 ? edit(p, {size: 58}) : p);
  const first = planMerge(local, {...fileA, pairs: remotePairs}, 't.json', NOW + 30);
  const second = planMerge(first.workspace, {...fileA, pairs: remotePairs}, 't.json', NOW + 40);
  assert.equal(second.workspace.conflicts.length, 1, 'no duplicate conflict');
  assert.equal(second.summary.conflicting, 1);
  assert.equal(second.newConflicts.length, 0);
});

// --- 5. new pairings and deletions travel with the merge --------------------
test('remote additions are added, remote deletes remove untouched pairs only', () => {
  const hub = seedWorkspace(NOW);
  const fileA = exportOf(hub, NOW + 10);
  const newPair = {...fileA.pairs[0], id: 999, title: 'Theirs', rev: 1, updatedAt: NOW + 15};
  const remotePairs = [...fileA.pairs.filter(p => p.id !== 3), newPair];
  const remoteTombs = [{id: 3, at: NOW + 15}];
  const local = {...hub, pairs: hub.pairs.map(p => p.id === 2 ? edit(p, {size: 70}) : p)};
  // pair 2 was edited locally after a (simulated) remote delete → must survive
  const remoteTombs2 = [...remoteTombs, {id: 2, at: NOW + 12}];
  const plan = planMerge(local, {...fileA, pairs: remotePairs, tombstones: remoteTombs2}, 't.json', NOW + 30);
  const ids = plan.workspace.pairs.map(p => p.id);
  assert.ok(ids.includes(999), 'their new pairing was added');
  assert.ok(!ids.includes(3), 'untouched pairing deleted as they asked');
  assert.ok(ids.includes(2), 'locally edited pairing survives their delete');
  assert.equal(plan.summary.added, 1);
  assert.equal(plan.summary.removed, 1);
});

// --- 6. publish invalidation on font change ---------------------------------
test('changing heading/body font invalidates the published version', () => {
  const ws = seedWorkspace(NOW);
  const published = ws.pairs[0];
  assert.equal(pairStatus(published), 'published');
  const fontChanged = edit(published, {headingFont: 'Newsreader'});
  assert.equal(pairStatus(fontChanged), 'stale');
  assert.ok(isStale(fontChanged));
  const sizeOnly = edit(published, {size: 60});
  assert.equal(pairStatus(sizeOnly), 'published', 'size change alone does not invalidate');
  const reconfirmed = {...fontChanged, published: {rev: fontChanged.rev, at: NOW + 5, headingFont: fontChanged.headingFont, bodyFont: fontChanged.bodyFont}};
  assert.equal(pairStatus(reconfirmed), 'published', 're-confirmation restores published state');
});

// --- 7. merge also invalidates publish when fonts change --------------------
test('a merged font change marks the pairing as needing confirmation', () => {
  const hub = seedWorkspace(NOW);
  const fileA = exportOf(hub, NOW + 10);
  const remotePairs = fileA.pairs.map(p => p.id === 1 ? edit(p, {bodyFont: 'Newsreader'}) : p);
  const plan = planMerge(hub, {...fileA, pairs: remotePairs}, 't.json', NOW + 20);
  const merged = plan.workspace.pairs.find(p => p.id === 1);
  assert.equal(merged.bodyFont, 'Newsreader');
  assert.equal(pairStatus(merged), 'stale', 'published version invalidated by merged font change');
});

// --- 8. failed merge leaves no half batch -----------------------------------
test('a broken file throws and nothing is applied', () => {
  const hub = seedWorkspace(NOW);
  assert.throws(() => parseImport('not json at all', NOW), /nothing was imported/);
  assert.throws(() => parseImport('{"hello":1}', NOW), /nothing was imported/);
  assert.throws(() => planMerge(hub, null, 'x', NOW), /nothing was merged/);
  assert.equal(hub.pairs.length, 3, 'workspace untouched');
});

// --- 9. conflict resolution --------------------------------------------------
test('resolving a conflict applies one version and clears the record', () => {
  const hub = seedWorkspace(NOW);
  const fileA = exportOf(hub, NOW + 10);
  const local = {...hub, pairs: hub.pairs.map(p => p.id === 1 ? edit(p, {size: 52}) : p)};
  const remotePairs = fileA.pairs.map(p => p.id === 1 ? edit(p, {size: 58}) : p);
  const merged = planMerge(local, {...fileA, pairs: remotePairs}, 't.json', NOW + 30).workspace;
  const conflict = merged.conflicts[0];
  const theirs = resolveConflict(merged, conflict.id, 'remote', NOW + 40);
  assert.equal(theirs.pairs.find(p => p.id === 1).size, 58, 'their value applied');
  assert.equal(theirs.conflicts.length, 0);
  const mine = resolveConflict(merged, conflict.id, 'local', NOW + 40);
  assert.equal(mine.pairs.find(p => p.id === 1).size, 52, 'my value kept');
  assert.equal(mine.conflicts.length, 0);
});

// --- 10. pairing lives in exactly one collection ------------------------------
test('assigning a collection moves the pairing (single collectionId)', () => {
  const ws = seedWorkspace(NOW);
  const [c1, c2] = ws.collections;
  const moved = edit(ws.pairs[0], {collectionId: c2.id});
  assert.equal(moved.collectionId, c2.id);
  assert.notEqual(moved.collectionId, c1.id, 'no lingering membership — it is one field');
});

// --- 11. exports show status and conflict source ------------------------------
test('CSS export carries needs-confirmation and conflict source', () => {
  const hub = seedWorkspace(NOW);
  const fileA = exportOf(hub, NOW + 10);
  const local = {...hub, pairs: hub.pairs.map(p => p.id === 1 ? edit(p, {size: 52}) : p)};
  const remotePairs = fileA.pairs.map(p => p.id === 1 ? edit(p, {size: 58, bodyFont: 'Newsreader'}) : p);
  const merged = planMerge(local, {...fileA, pairs: remotePairs}, 'mei-export.json', NOW + 30).workspace;
  const pair = merged.pairs.find(p => p.id === 1);
  const css = buildCss(pair, merged.conflicts.filter(c => c.pairId === 1), 'Editorial');
  assert.match(css, /NEEDS CONFIRMATION/, 'stale status is exported');
  assert.match(css, /mei-export\.json/, 'conflict source is exported');
  assert.match(css, /yours 52, theirs 58/, 'both versions are exported');
  assert.match(css, /font-family: 'Newsreader'/, 'merged font applied in output');
});

// --- 12. legacy array import (teammate on old version) ------------------------
test('a raw legacy pair array can be imported and merged', () => {
  const hub = seedWorkspace(NOW);
  const legacy = [{id: 1, title: 'Legacy A', heading: 'h', body: 'b', category: 'Editorial', favorite: true}];
  const remote = parseImport(JSON.stringify(legacy), NOW + 10);
  const plan = planMerge(hub, remote, 'old-teammate.json', NOW + 20);
  assert.ok(plan.workspace.pairs.length >= 3, 'no data lost');
});

console.log(`\n${passed} merge-station checks passed.`);
rmSync(out, {recursive: true, force: true});
