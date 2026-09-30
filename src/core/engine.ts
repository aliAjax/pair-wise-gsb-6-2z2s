// 纯逻辑层：字段修订、三方合并、冲突保留、发布失效判定。
// 不接触 DOM / localStorage，可直接在 Node 下自测。

import type {
  Bundle,
  ConflictEntry,
  FieldKey,
  LogEntry,
  Pair,
  Stamp,
  Workspace,
} from './types';

export const FIELD_KEYS: FieldKey[] = [
  'title',
  'category',
  'heading',
  'body',
  'headingFont',
  'bodyFont',
  'size',
  'weight',
  'leading',
  'tracking',
  'collectionId',
];

export const FIELD_LABELS: Record<FieldKey, string> = {
  title: '配对名称',
  category: '分类',
  heading: '标题文案',
  body: '正文文案',
  headingFont: '标题字体',
  bodyFont: '正文字体',
  size: '字号',
  weight: '字重',
  leading: '行高',
  tracking: '字距',
  collectionId: '所属合集',
};

export const FONT_FIELDS: FieldKey[] = ['headingFont', 'bodyFont'];

const MISSING = Symbol('missing');

export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function eq(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function conflictId(pairId: string, field: FieldKey): string {
  return `${pairId}::${field}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 改动一个被追踪的字段：修订号 +1、记下来源。
 *  字体改动不删旧发布快照——快照保留下来用于标注“旧版本已失效，待重新确认”。 */
export function bumpPair(
  pair: Pair,
  field: FieldKey,
  value: Pair[FieldKey],
  author: string,
  now: number,
): Pair {
  if (eq(pair[field], value)) return pair;
  const stamp: Stamp = {author, at: now};
  return {
    ...pair,
    [field]: value,
    revision: pair.revision + 1,
    updatedAt: now,
    updatedBy: author,
    sources: {...pair.sources, [field]: stamp},
  };
}

/** 收藏不属于排版修订，不升修订号，也不影响发布状态。 */
export function toggleFavorite(pair: Pair): Pair {
  return {...pair, favorite: !pair.favorite};
}

export type ConflictChoice =
  | {side: 'local' | 'incoming'}
  | {side: 'custom'; value: unknown};

/** 人工解决冲突：采用一版（或另给一版），冲突移除并升修订号。 */
export function resolveConflict(
  pair: Pair,
  field: FieldKey,
  choice: ConflictChoice,
  author: string,
  now: number,
): Pair {
  const entry = pair.conflicts.find((c) => c.field === field);
  if (!entry) return pair;
  const value: unknown =
    choice.side === 'custom'
      ? choice.value
      : choice.side === 'local'
        ? entry.localValue
        : entry.incomingValue;
  const stamp: Stamp = {author, at: now};
  // 旧发布快照保留：字体对不上时由 fontStatus 标 stale，提示重新确认。
  return {
    ...pair,
    [field]: value,
    revision: pair.revision + 1,
    updatedAt: now,
    updatedBy: author,
    sources: {...pair.sources, [field]: stamp},
    conflicts: pair.conflicts.filter((c) => c.id !== entry.id),
    published: pair.published,
  };
}

/** 发布状态：current 可用于导出；stale 表示字体变过，旧版本必须重新确认。 */
export function fontStatus(pair: Pair): 'unpublished' | 'current' | 'stale' {
  if (!pair.published) return 'unpublished';
  if (
    pair.published.headingFont !== pair.headingFont ||
    pair.published.bodyFont !== pair.bodyFont
  ) {
    return 'stale';
  }
  return 'current';
}

export function pendingReasons(pair: Pair): string[] {
  const reasons: string[] = [];
  const fontConflict = pair.conflicts.find((c) => FONT_FIELDS.includes(c.field));
  if (fontConflict) {
    reasons.push(
      `${FIELD_LABELS[fontConflict.field]}存在未解决冲突，解决前无法确认发布`,
    );
  }
  if (pair.published && fontStatus(pair) === 'stale') {
    reasons.push(
      `标题/正文字体已变化（旧发布版本 r${pair.published.revision} 已失效），需重新确认`,
    );
  } else if (!pair.published && !fontConflict) {
    reasons.push('尚未确认发布');
  }
  return reasons;
}

export function confirmPublish(pair: Pair, now: number): Pair {
  return {
    ...pair,
    published: {
      revision: pair.revision,
      headingFont: pair.headingFont,
      bodyFont: pair.bodyFont,
      at: now,
    },
  };
}

export function addLog(
  ws: Workspace,
  kind: LogEntry['kind'],
  text: string,
  now: number,
): Workspace {
  return {...ws, logs: [{at: now, kind, text}, ...ws.logs].slice(0, 100)};
}

export type FieldChangeKind =
  | 'unchanged'
  | 'accepted-local'
  | 'accepted-incoming'
  | 'identical'
  | 'conflict-new'
  | 'conflict-carried'
  | 'conflict-refreshed';

export interface FieldChange {
  field: FieldKey;
  kind: FieldChangeKind;
  localValue: unknown;
  incomingValue: unknown;
}

export interface PairReport {
  pairId: string;
  title: string;
  status: 'new' | 'updated' | 'unchanged' | 'conflicted';
  changes: FieldChange[];
}

export interface MergePlan {
  ok: true;
  workspace: Workspace;
  reports: PairReport[];
  bundleId: string;
  fromEditor: string;
  conflictCount: number;
  acceptedCount: number;
  newPairCount: number;
}

export type MergeResult =
  | MergePlan
  | {ok: false; error: string; duplicate?: boolean};

interface FieldOutcome {
  value: unknown;
  source: Stamp | undefined;
  kind: FieldChangeKind;
  /** 合并后基线里该字段的值；冲突字段保留旧基线。 */
  baseValue: unknown;
  baseHas: boolean;
}

function fallbackStamp(bundle: Bundle): Stamp {
  return {author: bundle.editorName, at: bundle.exportedAt};
}

/**
 * 三方合并单个字段。
 * local=本机现值，incoming=对端现值，base=共同基线。
 * 两边都改且结果不同 => 两版都保留并挂冲突，本机值暂为工作值。
 * activeConflicts 随字段逐个处理而累积，冲突记录不会互相覆盖。
 */
function mergeField(
  field: FieldKey,
  local: Pair,
  incoming: Pair,
  base: Pair | undefined,
  bundle: Bundle,
  activeConflicts: ConflictEntry[],
): {outcome: FieldOutcome; conflicts: ConflictEntry[]} {
  const pairId = local.id;
  const id = conflictId(pairId, field);
  const l = local[field];
  const i = incoming[field];
  const b: unknown = base ? base[field] : MISSING;
  const localChanged = !eq(l, b);
  const incomingChanged = !eq(i, b);
  const localOpen = local.conflicts.some((c) => c.id === id);
  const incomingOpen = incoming.conflicts.some((c) => c.id === id);
  const incomingStamp = incoming.sources[field] ?? fallbackStamp(bundle);
  const localStamp = local.sources[field];

  const without = (): ConflictEntry[] => activeConflicts.filter((c) => c.id !== id);
  const makeConflict = (): ConflictEntry => ({
    id,
    field,
    base: base ? base[field] : null,
    localValue: l,
    incomingValue: i,
    localSource: localStamp ?? fallbackStamp(bundle),
    incomingSource: incomingStamp,
  });

  // 冲突已在两端流传：以本地挂着的那份为准，只做收敛/续挂。
  if (localOpen && incomingOpen) {
    if (eq(l, i)) {
      return {
        conflicts: without(),
        outcome: {value: l, source: localStamp, kind: 'identical', baseValue: l, baseHas: true},
      };
    }
    return {
      conflicts: activeConflicts,
      outcome: {value: l, source: localStamp, kind: 'conflict-carried', baseValue: b, baseHas: !!base},
    };
  }

  // 本地还挂着、对端已解决：值一致即收敛，否则刷新对端版本继续挂冲突。
  if (localOpen && !incomingOpen) {
    if (eq(l, i)) {
      return {
        conflicts: without(),
        outcome: {value: l, source: localStamp, kind: 'identical', baseValue: l, baseHas: true},
      };
    }
    const existing = activeConflicts.find((c) => c.id === id)!;
    const refreshed: ConflictEntry = {
      ...existing,
      incomingValue: i,
      incomingSource: incomingStamp,
    };
    return {
      conflicts: activeConflicts.map((c) => (c.id === id ? refreshed : c)),
      outcome: {
        value: l,
        source: localStamp,
        kind: 'conflict-refreshed',
        baseValue: b,
        baseHas: !!base,
      },
    };
  }

  // 对端带着新冲突过来。
  if (incomingOpen && !localOpen) {
    if (!localChanged) {
      // 本机没动过：采用对端工作值，连同两版来源一起收下。
      const carried = incoming.conflicts.find((c) => c.id === id)!;
      return {
        conflicts: [...without(), carried],
        outcome: {
          value: i,
          source: incomingStamp,
          kind: 'conflict-carried',
          baseValue: b,
          baseHas: !!base,
        },
      };
    }
    if (eq(l, i)) {
      return {
        conflicts: without(),
        outcome: {value: l, source: localStamp, kind: 'identical', baseValue: l, baseHas: true},
      };
    }
    return {
      conflicts: [...without(), makeConflict()],
      outcome: {value: l, source: localStamp, kind: 'conflict-new', baseValue: b, baseHas: !!base},
    };
  }

  // 无在途冲突：常规三方合并。
  if (!localChanged && !incomingChanged) {
    return {
      conflicts: activeConflicts,
      outcome: {value: l, source: localStamp, kind: 'unchanged', baseValue: b, baseHas: !!base},
    };
  }
  if (localChanged && !incomingChanged) {
    return {
      conflicts: activeConflicts,
      outcome: {value: l, source: localStamp, kind: 'accepted-local', baseValue: l, baseHas: true},
    };
  }
  if (!localChanged && incomingChanged) {
    return {
      conflicts: activeConflicts,
      outcome: {value: i, source: incomingStamp, kind: 'accepted-incoming', baseValue: i, baseHas: true},
    };
  }
  // 两边都改了。
  if (eq(l, i)) {
    return {
      conflicts: without(),
      outcome: {value: l, source: localStamp, kind: 'identical', baseValue: l, baseHas: true},
    };
  }
  return {
    conflicts: [...without(), makeConflict()],
    outcome: {value: l, source: localStamp, kind: 'conflict-new', baseValue: b, baseHas: !!base},
  };
}

/** 产出合并计划（纯函数，不落盘）；落盘由 persistence 的原子提交负责。 */
export function planMerge(
  workspace: Workspace,
  bundle: Bundle,
  now: number,
): MergeResult {
  if (workspace.processedBundles.includes(bundle.bundleId)) {
    return {
      ok: false,
      error: `改动包 ${bundle.bundleId.slice(-6)} 已经并入过，为避免半批/重复数据已跳过`,
      duplicate: true,
    };
  }

  const ws = clone(workspace);
  const incomingById = new Map(Object.values(bundle.current).map((p) => [p.id, p]));
  const reports: PairReport[] = [];
  let conflictCount = 0;
  let acceptedCount = 0;
  let newPairCount = 0;

  // 合集只增不删，保证收藏和合集不丢。
  const knownCollections = new Set(ws.collections.map((c) => c.id));
  for (const c of bundle.collections) {
    if (!knownCollections.has(c.id)) {
      ws.collections.push(clone(c));
      knownCollections.add(c.id);
    }
  }

  for (const incoming of incomingById.values()) {
    const local = ws.pairs.find((p) => p.id === incoming.id);

    // 对端新建的配对：整条收下（含其携带的第三方冲突）。
    if (!local) {
      const added = clone(incoming);
      if (added.collectionId && !knownCollections.has(added.collectionId)) {
        const fallback = bundle.collections.find((c) => c.id === added.collectionId);
        if (fallback) {
          ws.collections.push(clone(fallback));
          knownCollections.add(fallback.id);
        } else {
          added.collectionId = null;
        }
      }
      ws.pairs.push(added);
      const basePair = clone(bundle.base[incoming.id] ?? added);
      basePair.conflicts = [];
      ws.base[added.id] = basePair;
      newPairCount += 1;
      acceptedCount += 1;
      reports.push({pairId: added.id, title: added.title, status: 'new', changes: []});
      continue;
    }

    const basePair = bundle.base[incoming.id] ?? ws.base[incoming.id];
    const merged: Pair = clone(local);
    const nextSources = {...local.sources};
    const mergedBase: Pair = clone(ws.base[incoming.id] ?? local);
    let activeConflicts: ConflictEntry[] = clone(local.conflicts);
    let touched = false;
    const changes: FieldChange[] = [];

    for (const field of FIELD_KEYS) {
      const {outcome, conflicts} = mergeField(
        field,
        local,
        incoming,
        basePair,
        bundle,
        activeConflicts,
      );
      activeConflicts = conflicts;
      const writable = merged as Record<FieldKey, unknown>;
      const baseWritable = mergedBase as Record<FieldKey, unknown>;
      if (!eq(writable[field], outcome.value)) touched = true;
      writable[field] = outcome.value;
      if (outcome.source) nextSources[field] = clone(outcome.source);
      if (outcome.baseHas && outcome.baseValue !== MISSING) {
        baseWritable[field] = clone(outcome.baseValue);
      }
      if (
        outcome.kind === 'conflict-new' ||
        outcome.kind === 'conflict-carried' ||
        outcome.kind === 'conflict-refreshed'
      ) {
        conflictCount += 1;
      }
      if (outcome.kind === 'accepted-incoming') acceptedCount += 1;
      if (outcome.kind !== 'unchanged') {
        changes.push({
          field,
          kind: outcome.kind,
          localValue: local[field],
          incomingValue: incoming[field],
        });
      }
    }

    merged.sources = nextSources;
    merged.conflicts = activeConflicts;

    if (!local.published && incoming.published) {
      const matches =
        incoming.published.headingFont === merged.headingFont &&
        incoming.published.bodyFont === merged.bodyFont;
      if (matches) merged.published = clone(incoming.published);
    }

    if (touched) {
      merged.revision = local.revision + 1;
      merged.updatedAt = now;
      merged.updatedBy = `${ws.editorName}（并入 ${bundle.editorName} 的改动）`;
    }
    mergedBase.conflicts = [];
    ws.base[incoming.id] = mergedBase;
    // 整批最后统一替换：中途任何字段出错都不会污染 ws（planMerge 是纯函数）。
    ws.pairs = ws.pairs.map((p) => (p.id === incoming.id ? merged : p));

    reports.push({
      pairId: incoming.id,
      title: merged.title,
      status: merged.conflicts.length > 0 ? 'conflicted' : touched ? 'updated' : 'unchanged',
      changes,
    });
  }

  ws.processedBundles = [...ws.processedBundles, bundle.bundleId];
  ws.lastImportedBundle = bundle.bundleId;

  return {
    ok: true,
    workspace: ws,
    reports,
    bundleId: bundle.bundleId,
    fromEditor: `${bundle.editorName}（${bundle.editorId}）`,
    conflictCount,
    acceptedCount,
    newPairCount,
  };
}
