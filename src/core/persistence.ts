// 持久化层：localStorage 原子提交（暂存→提交，失败回滚，不留半批）、
// 旧数据升级补修订号（收藏与合集不丢）、离线改动包解析/导出、CSS 导出。

import {
  addLog,
  clone,
  FIELD_LABELS,
  fontStatus,
  newId,
} from './engine';
import type {
  Bundle,
  Collection,
  FieldKey,
  LogEntry,
  Pair,
  Stamp,
  Workspace,
} from './types';

export const STORAGE_KEY = 'type-pairer-workspace-v2';
export const STAGE_KEY = 'type-pairer-stage-v2';
/** 旧版本应用占用的键，升级时从这里读旧数据。 */
export const LEGACY_KEY = 'type-pairs';

export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// ---------------------------------------------------------------------------
// 初始种子
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 8, 20, 2, 0);

function seedStamp(author: string, offsetMin: number): Stamp {
  return {author, at: T0 + offsetMin * 60_000};
}

interface SeedSpec {
  id: string;
  title: string;
  heading: string;
  body: string;
  category: string;
  collectionId: string;
  favorite: boolean;
  headingFont: string;
  bodyFont: string;
  size: number;
  weight: number;
  leading: number;
  tracking: number;
  revision: number;
  /** 给种子预置发布快照；字体与现值不一致时演示“旧版本失效待确认”。 */
  published?: {
    revision: number;
    headingFont: string;
    bodyFont: string;
  };
}

const SEED_COLLECTIONS: Collection[] = [
  {id: 'col-editorial', name: 'Editorial', color: '#e8b7a0'},
  {id: 'col-portfolio', name: 'Portfolio', color: '#9fc9be'},
  {id: 'col-brand', name: 'Brand voice', color: '#b4add8'},
];

const SEED_PAIRS: SeedSpec[] = [
  {
    id: 'p1',
    title: 'Editorial calm',
    heading: 'A slower way to see',
    body: 'Good typography creates space for ideas to breathe. Pair a confident display face with a quiet, generous text face.',
    category: 'Editorial',
    collectionId: 'col-editorial',
    favorite: true,
    headingFont: 'Fraunces',
    bodyFont: 'DM Sans',
    size: 46,
    weight: 600,
    leading: 1.25,
    tracking: 0,
    revision: 4,
    // 当前字体已换成 Fraunces，旧发布稿仍是 Newsreader：旧版本失效，页面/导出都提示重新确认。
    published: {revision: 3, headingFont: 'Newsreader', bodyFont: 'DM Sans'},
  },
  {
    id: 'p2',
    title: 'Studio notes',
    heading: 'Make room for the unexpected',
    body: 'A thoughtful pairing can add rhythm to even the simplest interface. Try contrast in shape, not just size.',
    category: 'Portfolio',
    collectionId: 'col-portfolio',
    favorite: false,
    headingFont: 'Space Grotesk',
    bodyFont: 'DM Sans',
    size: 42,
    weight: 500,
    leading: 1.3,
    tracking: 0.5,
    revision: 2,
    published: {revision: 2, headingFont: 'Space Grotesk', bodyFont: 'DM Sans'},
  },
  {
    id: 'p3',
    title: 'Field guide',
    heading: 'Small details, lasting impressions',
    body: 'Typography is the voice of a page. Find a combination that feels clear, warm and distinctly yours.',
    category: 'Brand',
    collectionId: 'col-brand',
    favorite: false,
    headingFont: 'Playfair Display',
    bodyFont: 'Newsreader',
    size: 44,
    weight: 500,
    leading: 1.2,
    tracking: 0,
    revision: 1,
  },
];

export function seedWorkspace(): Workspace {
  const pairs: Pair[] = SEED_PAIRS.map((s, idx) => {
    const stamp = seedStamp('Yuki Lin', idx * 12);
    const sources: Partial<Record<FieldKey, Stamp>> = {};
    for (const k of ['headingFont', 'bodyFont', 'size', 'weight', 'leading', 'tracking'] as FieldKey[]) {
      sources[k] = stamp;
    }
    const pair: Pair = {
      id: s.id,
      title: s.title,
      category: s.category,
      heading: s.heading,
      body: s.body,
      headingFont: s.headingFont,
      bodyFont: s.bodyFont,
      size: s.size,
      weight: s.weight,
      leading: s.leading,
      tracking: s.tracking,
      favorite: s.favorite,
      collectionId: s.collectionId,
      revision: s.revision,
      updatedAt: stamp.at,
      updatedBy: 'Yuki Lin',
      sources,
      published: s.published
        ? {...s.published, at: seedStamp('Yuki Lin', idx * 12 - 30).at}
        : null,
      conflicts: [],
    };
    return pair;
  });
  const base: Record<string, Pair> = {};
  for (const p of pairs) base[p.id] = clone(p);
  return {
    version: 2,
    editorId: 'you',
    editorName: 'Yuki Lin',
    pairs,
    collections: clone(SEED_COLLECTIONS),
    base,
    logs: [{at: T0, kind: 'migration', text: '初始化离线工作区'}],
    processedBundles: [],
    lastImportedBundle: null,
  };
}

// ---------------------------------------------------------------------------
// 旧数据迁移：缺修订号 => 补全；收藏与分类合集必须保留
// ---------------------------------------------------------------------------

interface LegacyPair {
  id: number;
  title: string;
  heading: string;
  body: string;
  category: string;
  favorite: boolean;
}

export function migrateLegacy(rawLegacy: unknown, now: number): Workspace {
  const list: LegacyPair[] = Array.isArray(rawLegacy) ? (rawLegacy as LegacyPair[]) : [];
  const collections: Collection[] = clone(SEED_COLLECTIONS);
  const known = new Map(collections.map((c) => [c.name.toLowerCase(), c.id]));

  const pairs: Pair[] = list
    .filter((p) => p && typeof p.id !== 'undefined')
    .map((p, idx) => {
      const category = typeof p.category === 'string' && p.category.trim() ? p.category.trim() : 'Untitled';
      let collectionId: string | null = null;
      const hit = known.get(category.toLowerCase());
      if (hit) {
        collectionId = hit;
      } else if (category.toLowerCase() !== 'untitled') {
        // 为旧分类补建同名合集，旧合集不丢。
        const created: Collection = {
          id: `col_legacy_${newId('c').slice(2)}`,
          name: category,
          color: '#cbb9d8',
        };
        collections.push(created);
        known.set(category.toLowerCase(), created.id);
        collectionId = created.id;
      }
      const stamp: Stamp = {author: '旧版数据', at: now + idx};
      const initial: Pair = {
        id: `legacy_${p.id}`,
        title: p.title ?? '未命名配对',
        category,
        heading: p.heading ?? '',
        body: p.body ?? '',
        headingFont: 'Fraunces',
        bodyFont: 'DM Sans',
        size: 46,
        weight: 600,
        leading: 1.25,
        tracking: 0,
        // 收藏原样保留。
        favorite: !!p.favorite,
        collectionId,
        // 旧数据没有修订号：统一补为 r1，并在日志中留痕。
        revision: 1,
        updatedAt: now + idx,
        updatedBy: '旧版数据（迁移补号）',
        sources: {
          headingFont: stamp,
          bodyFont: stamp,
          size: stamp,
          weight: stamp,
          leading: stamp,
          tracking: stamp,
        },
        // 旧版本没有发布确认概念，迁移后必须重新确认。
        published: null,
        conflicts: [],
      };
      return initial;
    });

  const base: Record<string, Pair> = {};
  for (const p of pairs) base[p.id] = clone(p);

  let ws: Workspace = {
    version: 2,
    editorId: 'you',
    editorName: 'Yuki Lin',
    pairs,
    collections,
    base,
    logs: [],
    processedBundles: [],
    lastImportedBundle: null,
  };
  const favCount = pairs.filter((p) => p.favorite).length;
  ws = addLog(
    ws,
    'migration',
    `旧版数据升级完成：补全 ${pairs.length} 条修订号（均从 r1 起），保留收藏 ${favCount} 条、合集 ${collections.length} 个；发布状态需重新确认`,
    now,
  );
  return ws;
}

// ---------------------------------------------------------------------------
// 原子提交：暂存 → 提交；任一步失败都清回旧数据，绝不留半批
// ---------------------------------------------------------------------------

export class CommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitError';
  }
}

/**
 * 原子写入。先把完整新工作区写到暂存键，再提交到正式键，最后清暂存。
 * 提交中途异常（包括注入的故障）会回滚正式键并清暂存，调用方重试即可。
 */
export function commitWorkspace(
  store: KVStore,
  next: Workspace,
  options: {failAtCommit?: boolean} = {},
): void {
  const previous = store.getItem(STORAGE_KEY);
  let staged = false;
  try {
    store.setItem(STAGE_KEY, JSON.stringify(next));
    staged = true;
    if (options.failAtCommit) {
      // 模拟“暂存成功、提交失败”，用于验证不会留下半批数据。
      throw new CommitError('模拟的写入故障（提交阶段）');
    }
    store.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    // 回滚：正式键恢复为旧值（原本不存在则删除），暂存清掉。
    if (previous === null) {
      store.removeItem(STORAGE_KEY);
    } else {
      store.setItem(STORAGE_KEY, previous);
    }
    if (staged) store.removeItem(STAGE_KEY);
    throw err instanceof CommitError
      ? err
      : new CommitError(err instanceof Error ? err.message : '写入失败');
  }
  store.removeItem(STAGE_KEY);
}

export interface LoadedWorkspace {
  workspace: Workspace;
  /** 上次合并提交失败留下的暂存：已安全回滚，正式键未被污染。 */
  recoveredStage: boolean;
}

/** 启动加载：正式键 → 旧版键迁移 → 种子；发现残留暂存一律视为失败现场并清掉。 */
export function loadWorkspace(store: KVStore, now: number): LoadedWorkspace {
  const staged = store.getItem(STAGE_KEY);
  if (staged) {
    store.removeItem(STAGE_KEY);
    const saved = store.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const ws = parseWorkspace(saved);
        return {
          workspace: addLog(
            ws,
            'rollback',
            '检测到上次合并提交残留的暂存数据，已丢弃；正式数据保持合并前状态，未写入半成品',
            now,
          ),
          recoveredStage: true,
        };
      } catch {
        // 正式数据损坏时落入迁移/种子流程。
      }
    }
  }

  const current = store.getItem(STORAGE_KEY);
  if (current) {
    return {workspace: parseWorkspace(current), recoveredStage: false};
  }
  const legacy = store.getItem(LEGACY_KEY);
  if (legacy !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(legacy);
    } catch {
      parsed = [];
    }
    if (Array.isArray(parsed) && parsed.length > 0) {
      const ws = migrateLegacy(parsed, now);
      commitWorkspace(store, ws);
      return {workspace: ws, recoveredStage: false};
    }
  }
  const seeded = seedWorkspace();
  commitWorkspace(store, seeded);
  return {workspace: seeded, recoveredStage: false};
}

function parseWorkspace(raw: string): Workspace {
  const data = JSON.parse(raw) as Workspace;
  if (
    !data ||
    data.version !== 2 ||
    !Array.isArray(data.pairs) ||
    !Array.isArray(data.collections) ||
    typeof data.base !== 'object' ||
    data.base === null
  ) {
    throw new Error('工作区数据不完整');
  }
  return data;
}

// ---------------------------------------------------------------------------
// 离线改动包
// ---------------------------------------------------------------------------

export function exportBundle(ws: Workspace, now: number): Bundle {
  return {
    format: 'type-pairer-bundle',
    bundleFormatVersion: 1,
    bundleId: newId('bun'),
    basedOnBundleId: ws.lastImportedBundle,
    editorId: ws.editorId,
    editorName: ws.editorName,
    exportedAt: now,
    base: clone(ws.base),
    current: Object.fromEntries(ws.pairs.map((p) => [p.id, clone(p)])),
    collections: clone(ws.collections),
  };
}

export function serializeBundle(bundle: Bundle): string {
  return JSON.stringify(bundle, null, 2);
}

export function parseBundle(text: string): Bundle {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('文件不是合法的 JSON 改动包');
  }
  const b = data as Partial<Bundle>;
  if (!b || b.format !== 'type-pairer-bundle') {
    throw new Error('缺少 type-pairer-bundle 标识，不是本机的离线改动包');
  }
  if (b.bundleFormatVersion !== 1) {
    throw new Error(`改动包版本 ${String(b.bundleFormatVersion)} 不受支持`);
  }
  if (!b.bundleId || !b.editorId || !b.editorName || typeof b.exportedAt !== 'number') {
    throw new Error('改动包缺少作者或时间信息');
  }
  if (typeof b.base !== 'object' || b.base === null || typeof b.current !== 'object' || b.current === null) {
    throw new Error('改动包缺少基线或当前数据');
  }
  if (!Array.isArray(b.collections)) {
    throw new Error('改动包缺少合集数据');
  }
  return data as Bundle;
}

// ---------------------------------------------------------------------------
// CSS 导出：页面与导出都必须显示待确认与冲突来源
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<ReturnType<typeof fontStatus>, string> = {
  current: '已确认发布（当前版本）',
  stale: '待重新确认：标题/正文字体变化后旧发布版本已失效',
  unpublished: '待确认：尚未确认发布',
};

export function formatValue(field: FieldKey, value: unknown, collections: Collection[]): string {
  if (field === 'collectionId') {
    if (value === null) return '（未归入合集）';
    return collections.find((c) => c.id === value)?.name ?? String(value);
  }
  if (field === 'size') return `${value}px`;
  if (field === 'tracking') return `${value}px`;
  if (field === 'leading') return String(value);
  if (field === 'weight') return String(value);
  return value === null || value === undefined ? '' : String(value);
}

export function exportCss(pair: Pair, collections: Collection[]): string {
  const status = fontStatus(pair);
  const lines: string[] = [];
  lines.push('/*');
  lines.push(` * 配对：${pair.title}（${pair.category}） · 修订号 r${pair.revision}`);
  lines.push(` * 发布状态：${STATUS_TEXT[status]}`);
  if (pair.published) {
    lines.push(` * 已确认版本：r${pair.published.revision} @ ${new Date(pair.published.at).toLocaleString('zh-CN')}`);
  }
  if (pair.conflicts.length > 0) {
    lines.push(` * ⚠ 待处理冲突 ${pair.conflicts.length} 项（以下 CSS 暂取“本机版”工作值，不可作为发布稿）：`);
    for (const c of pair.conflicts) {
      lines.push(
        ` *   - ${FIELD_LABELS[c.field]}：本机版=${formatValue(c.field, c.localValue, collections)}` +
          `（${c.localSource.author} · ${new Date(c.localSource.at).toLocaleString('zh-CN')}）` +
          ` ｜ 对端版=${formatValue(c.field, c.incomingValue, collections)}` +
          `（${c.incomingSource.author} · ${new Date(c.incomingSource.at).toLocaleString('zh-CN')}）`,
      );
    }
  }
  lines.push(` * 所属合集：${formatValue('collectionId', pair.collectionId, collections)}（配对只能属于一个合集）`);
  lines.push(` * 最后修改：${pair.updatedBy} · ${new Date(pair.updatedAt).toLocaleString('zh-CN')}`);
  lines.push(' */');
  lines.push(`.heading-${pair.id} {`);
  lines.push(`  font-family: '${pair.headingFont}', serif;`);
  lines.push(`  font-size: ${pair.size}px;`);
  lines.push(`  font-weight: ${pair.weight};`);
  lines.push('}');
  lines.push(`.body-${pair.id} {`);
  lines.push(`  font-family: '${pair.bodyFont}', sans-serif;`);
  lines.push(`  line-height: ${pair.leading};`);
  lines.push(`  letter-spacing: ${pair.tracking}px;`);
  lines.push('}');
  return lines.join('\n');
}
