// 离线自测：node --import tsx selftest/run.ts，或 npx tsc -p selftest/tsconfig.json && node selftest/dist/run.js
import assert from 'node:assert';
import {
  bumpPair,
  clone,
  confirmPublish,
  conflictId,
  fontStatus,
  FONT_FIELDS,
  planMerge,
  resolveConflict,
} from '../src/core/engine';
import type {Bundle, FieldKey, Pair, Workspace} from '../src/core/types';
import {
  commitWorkspace,
  exportBundle,
  exportCss,
  KVStore,
  loadWorkspace,
  migrateLegacy,
  parseBundle,
  seedWorkspace,
  serializeBundle,
  STAGE_KEY,
  STORAGE_KEY,
} from '../src/core/persistence';

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ---- 工具 ---------------------------------------------------------------

function makeEditor(seed: Workspace, editorId: string, name: string): Workspace {
  const ws = clone(seed);
  ws.editorId = editorId;
  ws.editorName = name;
  return ws;
}

function findPair(ws: Workspace, id: string): Pair {
  const p = ws.pairs.find((x) => x.id === id);
  assert.ok(p, `pair ${id} should exist`);
  return p!;
}

function makeBundle(ws: Workspace, now: number): Bundle {
  return exportBundle(ws, now);
}

function importBundleOk(ws: Workspace, bundle: Bundle, now: number): Workspace {
  const plan = planMerge(ws, bundle, now);
  assert.ok(plan.ok, plan.ok ? '' : plan.error);
  return plan.workspace;
}

// ---- 1. 基本修订与发布失效 ----------------------------------------------

test('改字号升修订号；改标题字体后旧发布失效，需重新确认；确认后恢复 current', () => {
  const seed = seedWorkspace();
  let p = findPair(seed, 'p2'); // p2 已确认 current
  assert.strictEqual(fontStatus(p), 'current');
  const r0 = p.revision;
  p = bumpPair(p, 'size', 52, 'Yuki Lin', Date.now());
  assert.strictEqual(p.revision, r0 + 1);
  // 只调字号，发布快照仍在且字体未变 => current
  assert.strictEqual(fontStatus(p), 'current');

  p = bumpPair(p, 'headingFont', 'Fraunces', 'Yuki Lin', Date.now());
  assert.strictEqual(p.revision, r0 + 2);
  assert.ok(p.published, '旧发布快照必须保留，用于标注已失效');
  assert.strictEqual(fontStatus(p), 'stale');

  p = confirmPublish(p, Date.now());
  assert.strictEqual(fontStatus(p), 'current');
  assert.strictEqual(p.published!.headingFont, 'Fraunces');
});

test('收藏切换不升修订号、不影响发布状态', () => {
  const seed = seedWorkspace();
  const p = findPair(seed, 'p1');
  const r0 = p.revision;
  const fav = p.favorite;
  const p2 = {...p, favorite: !fav}; // 模拟 toggleFavorite
  assert.strictEqual(p2.revision, r0);
  assert.strictEqual(fontStatus(p2), fontStatus(p));
  assert.strictEqual(p2.favorite, !fav);
});

// ---- 2. 三方合并：同字段两边都改 => 保留两版并标冲突 -------------------

test('两边改同一字段（字距）不同值：两版都保留、挂冲突、来源齐全，未改字段自动并入', () => {
  const T = 1_760_000_000_000;
  const seed = seedWorkspace();
  const alice = makeEditor(seed, 'alice', 'Alice');
  const bob = makeEditor(seed, 'bob', 'Bob');

  // Alice 把 p2 字距改为 2
  let a2 = findPair(alice, 'p2');
  a2 = bumpPair(a2, 'tracking', 2, 'Alice', T + 1000);
  alice.pairs = alice.pairs.map((x) => (x.id === 'p2' ? a2 : x));
  // Alice 同时把字号改成 50（Bob 没动，应自动并入）
  a2 = bumpPair(a2, 'size', 50, 'Alice', T + 2000);
  alice.pairs = alice.pairs.map((x) => (x.id === 'p2' ? a2 : x));

  // Bob 把字距改成 -0.5
  let b2 = findPair(bob, 'p2');
  b2 = bumpPair(b2, 'tracking', -0.5, 'Bob', T + 3000);
  bob.pairs = bob.pairs.map((x) => (x.id === 'p2' ? b2 : x));

  const bundle = makeBundle(alice, T + 5000);
  const merged = importBundleOk(bob, bundle, T + 6000);
  const m2 = findPair(merged, 'p2');

  // 字距冲突：两版都在
  const c = m2.conflicts.find((x) => x.field === 'tracking');
  assert.ok(c, 'tracking 字段应标冲突');
  assert.strictEqual(c!.localValue, -0.5);
  assert.strictEqual(c!.incomingValue, 2);
  assert.strictEqual(c!.localSource.author, 'Bob');
  assert.strictEqual(c!.incomingSource.author, 'Alice');
  assert.strictEqual(c!.id, conflictId('p2', 'tracking'));
  // 工作值暂取本机
  assert.strictEqual(m2.tracking, -0.5);
  // 非冲突字段自动并入
  assert.strictEqual(m2.size, 50);
  // 基线里冲突字段保持旧基线，自动并入字段更新
  assert.strictEqual(merged.base['p2'].tracking, 0.5);
  assert.strictEqual(merged.base['p2'].size, 50);
});

test('两边都改但改得一样 => 不产生冲突；只有一边改 => 自动并入', () => {
  const T = 1_760_000_000_000;
  const seed = seedWorkspace();
  const alice = makeEditor(seed, 'alice', 'Alice');
  const bob = makeEditor(seed, 'bob', 'Bob');
  let a2 = bumpPair(findPair(alice, 'p2'), 'weight', 700, 'Alice', T);
  alice.pairs = alice.pairs.map((x) => (x.id === 'p2' ? a2 : x));
  let b2 = bumpPair(findPair(bob, 'p2'), 'weight', 700, 'Bob', T + 10);
  b2 = bumpPair(b2, 'leading', 1.6, 'Bob', T + 20);
  bob.pairs = bob.pairs.map((x) => (x.id === 'p2' ? b2 : x));

  const merged = importBundleOk(bob, makeBundle(alice, T + 30), T + 40);
  const m2 = findPair(merged, 'p2');
  assert.strictEqual(m2.conflicts.length, 0);
  assert.strictEqual(m2.weight, 700);
  assert.strictEqual(m2.leading, 1.6);
});

test('解决冲突：选对端版升修订号并移除冲突，冲突来源随之消失', () => {
  const T = 1_760_000_000_000;
  const seed = seedWorkspace();
  const alice = makeEditor(seed, 'alice', 'Alice');
  const bob = makeEditor(seed, 'bob', 'Bob');
  let a2 = bumpPair(findPair(alice, 'p2'), 'tracking', 2, 'Alice', T);
  alice.pairs = alice.pairs.map((x) => (x.id === 'p2' ? a2 : x));
  let b2 = bumpPair(findPair(bob, 'p2'), 'tracking', -0.5, 'Bob', T + 1);
  bob.pairs = bob.pairs.map((x) => (x.id === 'p2' ? b2 : x));
  let merged = importBundleOk(bob, makeBundle(alice, T + 2), T + 3);
  let m2 = findPair(merged, 'p2');
  const r0 = m2.revision;
  m2 = resolveConflict(m2, 'tracking', {side: 'incoming'}, 'Bob', T + 4);
  merged = {...merged, pairs: merged.pairs.map((x) => (x.id === 'p2' ? m2 : x))};
  assert.strictEqual(m2.tracking, 2);
  assert.strictEqual(m2.conflicts.length, 0);
  assert.strictEqual(m2.revision, r0 + 1);
});

// ---- 3. 多字段、多跳离线传播 --------------------------------------------

test('多个字段同时冲突会各自保留两版，不会互相覆盖', () => {
  const T = 1_760_000_000_000;
  const seed = seedWorkspace();
  const alice = makeEditor(seed, 'alice', 'Alice');
  const bob = makeEditor(seed, 'bob', 'Bob');
  const fields: Array<[FieldKey, number, number]> = [
    ['size', 60, 30],
    ['tracking', 2, -1],
    ['leading', 1.7, 1.1],
    ['weight', 800, 300],
  ];
  let a2 = findPair(alice, 'p2');
  let b2 = findPair(bob, 'p2');
  fields.forEach(([field, av, bv], i) => {
    a2 = bumpPair(a2, field, av, 'Alice', T + i);
    b2 = bumpPair(b2, field, bv, 'Bob', T + i);
  });
  alice.pairs = alice.pairs.map((x) => (x.id === 'p2' ? a2 : x));
  bob.pairs = bob.pairs.map((x) => (x.id === 'p2' ? b2 : x));

  const merged = importBundleOk(bob, makeBundle(alice, T + 99), T + 100);
  const m2 = findPair(merged, 'p2');
  assert.strictEqual(m2.conflicts.length, 4);
  for (const [field, av, bv] of fields) {
    const c = m2.conflicts.find((x) => x.field === field);
    assert.ok(c, `${field} 冲突缺失`);
    assert.strictEqual(c!.incomingValue, av);
    assert.strictEqual(c!.localValue, bv);
  }
});

test('冲突随离线包继续传递：第三方先收 Alice 再收 Bob 也能挂出两版', () => {
  const T = 1_760_000_000_000;
  const seed = seedWorkspace();
  const alice = makeEditor(seed, 'alice', 'Alice');
  const bob = makeEditor(seed, 'bob', 'Bob');
  const carol = makeEditor(seed, 'carol', 'Carol');

  let a1 = bumpPair(findPair(alice, 'p2'), 'size', 64, 'Alice', T);
  alice.pairs = alice.pairs.map((x) => (x.id === 'p2' ? a1 : x));
  let b1 = bumpPair(findPair(bob, 'p2'), 'size', 32, 'Bob', T + 1);
  bob.pairs = bob.pairs.map((x) => (x.id === 'p2' ? b1 : x));

  const aBundle = makeBundle(alice, T + 10);
  // Carol 先收 Alice（自动并入 64），再收 Bob（Bob 基线仍是旧值，两边都改 => 冲突）
  let carolMerged = importBundleOk(carol, aBundle, T + 11);
  assert.strictEqual(findPair(carolMerged, 'p2').size, 64);
  carolMerged = importBundleOk(carolMerged, makeBundle(bob, T + 12), T + 13);
  const c2 = findPair(carolMerged, 'p2');
  const c = c2.conflicts.find((x) => x.field === 'size');
  assert.ok(c, '经多跳离线传递后仍应保留两版');
  assert.strictEqual(c!.incomingValue, 32);
  assert.strictEqual(c!.localValue, 64);
});

test('对端已解决冲突、选值与本机一致时自动收敛', () => {
  const T = 1_760_000_000_000;
  const seed = seedWorkspace();
  const alice = makeEditor(seed, 'alice', 'Alice');
  const bob = makeEditor(seed, 'bob', 'Bob');
  let a = bumpPair(findPair(alice, 'p2'), 'tracking', 2, 'Alice', T);
  alice.pairs = alice.pairs.map((x) => (x.id === 'p2' ? a : x));
  let b = bumpPair(findPair(bob, 'p2'), 'tracking', -0.5, 'Bob', T + 1);
  bob.pairs = bob.pairs.map((x) => (x.id === 'p2' ? b : x));

  // Bob 收包产生冲突，随后 Bob 选了 Alice 的 2
  let merged = importBundleOk(bob, makeBundle(alice, T + 2), T + 3);
  let m2 = findPair(merged, 'p2');
  m2 = resolveConflict(m2, 'tracking', {side: 'incoming'}, 'Bob', T + 4);
  merged = {...merged, pairs: merged.pairs.map((x) => (x.id === 'p2' ? m2 : x))};

  // Alice 再收 Bob 已解决的包：两边值一致，冲突消失
  const again = importBundleOk(alice, makeBundle(merged, T + 5), T + 6);
  assert.strictEqual(findPair(again, 'p2').conflicts.length, 0);
  assert.strictEqual(findPair(again, 'p2').tracking, 2);
});

// ---- 4. 新建配对、合集、收藏 -------------------------------------------

test('对端新建配对整条收下；合集只增不删；配对单合集归属', () => {
  const T = 1_760_000_000_000;
  const seed = seedWorkspace();
  const alice = makeEditor(seed, 'alice', 'Alice');
  const bob = makeEditor(seed, 'bob', 'Bob');
  const newPair: Pair = {
    ...clone(findPair(alice, 'p1')),
    id: 'p_new',
    title: 'Fresh',
    heading: 'Brand new',
    favorite: true,
    collectionId: 'col-editorial',
    conflicts: [],
    published: null,
  };
  alice.pairs = [...alice.pairs, newPair];
  alice.base[newPair.id] = clone(newPair);

  const merged = importBundleOk(bob, makeBundle(alice, T), T + 1);
  const got = findPair(merged, 'p_new');
  assert.strictEqual(got.favorite, true);
  assert.strictEqual(got.collectionId, 'col-editorial');
  assert.ok(merged.base['p_new']);
  // Bob 自己的收藏/合集都在
  assert.ok(findPair(merged, 'p1').favorite === true);
  const names = merged.collections.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ['Brand voice', 'Editorial', 'Portfolio']);
});

test('合集归属冲突也按三方合并，单字段保证配对只属于一个合集', () => {
  const T = 1_760_000_000_000;
  const seed = seedWorkspace();
  const alice = makeEditor(seed, 'alice', 'Alice');
  const bob = makeEditor(seed, 'bob', 'Bob');
  let a = bumpPair(findPair(alice, 'p3'), 'collectionId', 'col-editorial', 'Alice', T);
  alice.pairs = alice.pairs.map((x) => (x.id === 'p3' ? a : x));
  let b = bumpPair(findPair(bob, 'p3'), 'collectionId', 'col-portfolio', 'Bob', T + 1);
  bob.pairs = bob.pairs.map((x) => (x.id === 'p3' ? b : x));
  const merged = importBundleOk(bob, makeBundle(alice, T + 2), T + 3);
  const m3 = findPair(merged, 'p3');
  const c = m3.conflicts.find((x) => x.field === 'collectionId');
  assert.ok(c, '合集归属同改应冲突');
  // 任意时刻 collectionId 都是单值
  assert.ok(m3.collectionId === 'col-portfolio' || m3.collectionId === 'col-editorial');
});

// ---- 5. 幂等与原子提交 --------------------------------------------------

test('同一改动包重复导入被拒绝（processedBundles 去重）', () => {
  const T = 1_760_000_000_000;
  const seed = seedWorkspace();
  const alice = makeEditor(seed, 'alice', 'Alice');
  let a = bumpPair(findPair(alice, 'p2'), 'size', 60, 'Alice', T);
  alice.pairs = alice.pairs.map((x) => (x.id === 'p2' ? a : x));
  const bundle = makeBundle(alice, T + 1);
  const once = importBundleOk(seed, bundle, T + 2);
  const again = planMerge(once, bundle, T + 3);
  assert.strictEqual(again.ok, false);
  assert.strictEqual((again as {duplicate?: boolean}).duplicate, true);
});

function memStore(): KVStore & {data: Map<string, string>} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test('合并提交失败（提交阶段抛错）不留半批：正式键保持合并前，暂存被清理，重试成功', () => {
  const T = 1_760_000_000_000;
  const store = memStore();
  const before = seedWorkspace();
  commitWorkspace(store, before);
  const snapshotBefore = store.getItem(STORAGE_KEY)!;

  // 造一个合并结果
  const alice = makeEditor(before, 'alice', 'Alice');
  let a = bumpPair(findPair(alice, 'p2'), 'size', 60, 'Alice', T);
  alice.pairs = alice.pairs.map((x) => (x.id === 'p2' ? a : x));
  const plan = planMerge(before, makeBundle(alice, T + 1), T + 2);
  assert.ok(plan.ok);
  const next = plan.workspace;

  // 第一次提交：在提交阶段注入故障
  assert.throws(() => commitWorkspace(store, next, {failAtCommit: true}));
  // 正式键原样
  assert.strictEqual(store.getItem(STORAGE_KEY), snapshotBefore);
  // 没有暂存残留
  assert.strictEqual(store.getItem(STAGE_KEY), null);
  // 正式数据里不应出现合并后的 60
  const stillOld = JSON.parse(store.getItem(STORAGE_KEY)!) as Workspace;
  assert.strictEqual(findPair(stillOld, 'p2').size, 42);

  // 重试提交成功（同一批数据，不经过 planMerge，所以不存在 processedBundles 阻碍）
  commitWorkspace(store, next);
  assert.strictEqual(store.getItem(STAGE_KEY), null);
  const after = JSON.parse(store.getItem(STORAGE_KEY)!) as Workspace;
  assert.strictEqual(findPair(after, 'p2').size, 60);
});

test('启动时发现暂存残留：判定为失败现场，正式数据不动并记录回滚日志', () => {
  const store = memStore();
  const before = seedWorkspace();
  commitWorkspace(store, before);
  // 人为制造暂存残留 + 一份“半批”的危险内容
  const half = clone(before);
  const hp = bumpPair(findPair(half, 'p2'), 'size', 99, 'x', 1);
  half.pairs = half.pairs.map((x) => (x.id === 'p2' ? hp : x));
  store.setItem(STAGE_KEY, JSON.stringify(half));

  const {workspace, recoveredStage} = loadWorkspace(store, 2_000);
  assert.strictEqual(recoveredStage, true);
  assert.strictEqual(findPair(workspace, 'p2').size, 42, '半批数据绝不能生效');
  assert.strictEqual(store.getItem(STAGE_KEY), null);
  assert.ok(workspace.logs.some((l) => l.kind === 'rollback'));
});

// ---- 6. 旧数据迁移 ------------------------------------------------------

test('旧数据（无修订号）升级：补 r1、收藏不丢、旧分类补建合集、需重新确认', () => {
  const legacy = [
    {id: 1, title: 'Old one', heading: 'H1', body: 'B1', category: 'Editorial', favorite: true},
    {id: 2, title: 'Old two', heading: 'H2', body: 'B2', category: 'Poster', favorite: false},
    {id: 3, title: 'Old three', heading: 'H3', body: 'B3', favorite: true},
  ];
  const ws = migrateLegacy(legacy, 5_000);
  assert.strictEqual(ws.pairs.length, 3);
  for (const p of ws.pairs) {
    assert.strictEqual(p.revision, 1, '旧数据补修订号 r1');
    assert.strictEqual(p.published, null, '旧数据需重新确认发布');
    assert.ok(p.id.startsWith('legacy_'));
  }
  const favs = ws.pairs.filter((p) => p.favorite).map((p) => p.title);
  assert.deepStrictEqual(favs, ['Old one', 'Old three']);
  const poster = ws.pairs.find((p) => p.category === 'Poster')!;
  assert.ok(poster.collectionId, '旧分类应归入合集');
  const col = ws.collections.find((c) => c.id === poster.collectionId);
  assert.strictEqual(col!.name, 'Poster');
  // 原有合集保留
  const names = ws.collections.map((c) => c.name);
  for (const n of ['Editorial', 'Portfolio', 'Brand voice']) assert.ok(names.includes(n));
  // 基线完整
  for (const p of ws.pairs) assert.ok(ws.base[p.id]);
  assert.ok(ws.logs.some((l) => l.kind === 'migration'));
});

test('loadWorkspace 从旧键自动迁移并清掉旧键以外不影响后续启动', () => {
  const store = memStore();
  store.setItem(
    'type-pairs',
    JSON.stringify([{id: 7, title: 'Leg', heading: 'h', body: 'b', category: 'Brand', favorite: true}]),
  );
  const first = loadWorkspace(store, 9);
  assert.strictEqual(first.workspace.pairs.length, 1);
  assert.strictEqual(first.workspace.pairs[0].revision, 1);
  // 再次加载走新键，不重复迁移
  const second = loadWorkspace(store, 10);
  assert.strictEqual(second.workspace.pairs.length, 1);
  assert.strictEqual(second.workspace.pairs[0].favorite, true);
});

// ---- 7. 离线包往返 & 导出标注 ------------------------------------------

test('改动包序列化/解析往返保持内容；坏包被拒绝', () => {
  const seed = seedWorkspace();
  const bundle = makeBundle(seed, 123);
  const text = serializeBundle(bundle);
  const back = parseBundle(text);
  assert.strictEqual(back.bundleId, bundle.bundleId);
  assert.strictEqual(Object.keys(back.current).length, seed.pairs.length);
  assert.throws(() => parseBundle('{'));
  assert.throws(() => parseBundle(JSON.stringify({format: 'nope'})));
});

test('CSS 导出包含发布状态、待确认与冲突双方来源', () => {
  const T = 1_760_000_000_000;
  const seed = seedWorkspace();
  // p1 预置 stale
  const stale = findPair(seed, 'p1');
  assert.strictEqual(fontStatus(stale), 'stale');
  const css1 = exportCss(stale, seed.collections);
  assert.ok(css1.includes('待重新确认'));
  assert.ok(css1.includes(`r${stale.revision}`));

  // 造冲突
  const alice = makeEditor(seed, 'alice', 'Alice');
  const bob = makeEditor(seed, 'bob', 'Bob');
  let a = bumpPair(findPair(alice, 'p2'), 'bodyFont', 'IBM Plex Sans', 'Alice', T);
  alice.pairs = alice.pairs.map((x) => (x.id === 'p2' ? a : x));
  let b = bumpPair(findPair(bob, 'p2'), 'bodyFont', 'Newsreader', 'Bob', T + 1);
  bob.pairs = bob.pairs.map((x) => (x.id === 'p2' ? b : x));
  const merged = importBundleOk(bob, makeBundle(alice, T + 2), T + 3);
  const m2 = findPair(merged, 'p2');
  assert.ok(m2.conflicts.some((c) => FONT_FIELDS.includes(c.field)));
  const css2 = exportCss(m2, merged.collections);
  assert.ok(css2.includes('冲突'));
  assert.ok(css2.includes('Alice'));
  assert.ok(css2.includes('Bob'));
  assert.ok(css2.includes('IBM Plex Sans'));
  assert.ok(css2.includes('Newsreader'));
});

// ---- 汇总 ---------------------------------------------------------------

console.log(`\n${passed} 个测试通过`);
if (process.exitCode) console.error('存在失败用例');
