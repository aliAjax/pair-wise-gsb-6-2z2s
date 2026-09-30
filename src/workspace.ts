// Type Pairer — workspace data model (v2), offline merge station, migration.
//
// Merge model: every pairing carries `base`, a snapshot of itself at the last
// sync point (export / successful merge / migration). Merging a teammate's
// export is a field-level three-way merge: for each field we compare local,
// remote and the ancestor snapshot. If both sides changed the same field to
// different values we keep the local value applied, store the remote value in
// a conflict record (with the source file name) and leave `base` untouched so
// re-importing the same file reproduces — not duplicates — the conflict.
//
// Atomicity: planMerge() is a pure function that either returns a complete
// next workspace or throws. The app commits it with a single state update and
// a single localStorage write, so a failed merge never leaves half a batch
// behind and retrying is always safe.

export const WORKSPACE_KEY = 'type-pairer-workspace-v2';
export const WORKSPACE_BACKUP_KEY = 'type-pairer-workspace-v2-backup';
export const LEGACY_KEY = 'type-pairs';

export const MERGE_FIELDS = [
  'title', 'heading', 'body', 'category', 'favorite', 'collectionId',
  'headingFont', 'bodyFont', 'size', 'weight', 'leading', 'tracking',
] as const;
export type PairField = (typeof MERGE_FIELDS)[number];

export const FIELD_LABELS: Record<PairField, string> = {
  title: 'Title', heading: 'Heading text', body: 'Body text', category: 'Category',
  favorite: 'Favorite', collectionId: 'Collection',
  headingFont: 'Heading font', bodyFont: 'Body font',
  size: 'Size', weight: 'Weight', leading: 'Line height', tracking: 'Letter spacing',
};

export interface PairSnapshot {
  title: string;
  heading: string;
  body: string;
  category: string;
  favorite: boolean;
  collectionId: number | null; // a pairing lives in at most one collection
  headingFont: string;
  bodyFont: string;
  size: number;
  weight: number;
  leading: number;
  tracking: number;
}

export interface PublishedInfo {
  rev: number;
  at: number;
  headingFont: string; // font snapshot at publish time — changing either font
  bodyFont: string;    // afterwards invalidates the published version
}

export interface Pair extends PairSnapshot {
  id: number;
  rev: number;          // bumped on every local edit; backfilled for legacy data
  updatedAt: number;
  base: PairSnapshot | null; // ancestor snapshot from the last sync point
  published: PublishedInfo | null; // null = draft
}

export interface Collection {
  id: number;
  name: string;
  color: string;
  rev: number;
  updatedAt: number;
}

export interface Conflict {
  id: string;
  pairId: number;
  pairTitle: string;
  field: PairField;
  localValue: unknown;  // stays applied
  remoteValue: unknown; // kept for review — both versions survive the merge
  source: string;       // where the remote version came from (file name)
  at: number;
}

export interface Tombstone { id: number; at: number; }

export interface Workspace {
  version: 2;
  pairs: Pair[];
  collections: Collection[];
  conflicts: Conflict[];
  tombstones: Tombstone[];
  exportedAt: number | null;
}

export interface ExportData {
  pairs: Pair[];
  collections: Collection[];
  tombstones: Tombstone[];
  conflicts: Conflict[];
}

export interface MergeSummary {
  added: number;       // pairings that only existed on their side
  updated: number;     // pairings where their edits were applied cleanly
  conflicting: number; // pairings where both sides touched the same field
  removed: number;     // pairings they deleted and we had not touched
}

export interface MergePlan {
  workspace: Workspace;
  summary: MergeSummary;
  newConflicts: Conflict[];
}

export const DEFAULT_PAIR_FIELDS: PairSnapshot = {
  title: 'Untitled pairing',
  heading: 'Your new headline',
  body: 'Start with a sentence that lets your type pairing show its character.',
  category: 'Untitled',
  favorite: false,
  collectionId: null,
  headingFont: 'Fraunces',
  bodyFont: 'DM Sans',
  size: 46,
  weight: 600,
  leading: 1.25,
  tracking: 0,
};

const COLLECTION_PALETTE = ['#e8b7a0', '#9fc9be', '#b4add8', '#e5c07b', '#8fb8d8', '#d89aa6'];

export function snapshotOf(p: PairSnapshot): PairSnapshot {
  return {
    title: p.title, heading: p.heading, body: p.body, category: p.category,
    favorite: p.favorite, collectionId: p.collectionId,
    headingFont: p.headingFont, bodyFont: p.bodyFont,
    size: p.size, weight: p.weight, leading: p.leading, tracking: p.tracking,
  };
}

export function newId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

// ---------------------------------------------------------------------------
// Publish state
// ---------------------------------------------------------------------------

export type PairStatus = 'draft' | 'published' | 'stale';

/** A published pairing goes stale as soon as the heading or body font changes. */
export function isStale(p: Pair): boolean {
  return !!p.published && (p.headingFont !== p.published.headingFont || p.bodyFont !== p.published.bodyFont);
}

export function pairStatus(p: Pair): PairStatus {
  if (!p.published) return 'draft';
  return isStale(p) ? 'stale' : 'published';
}

// ---------------------------------------------------------------------------
// Normalization & migration
// ---------------------------------------------------------------------------

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/** Fill anything missing (legacy rows have no rev/fonts/collection) with defaults. */
export function normalizePair(raw: unknown, now: number): Pair {
  const r = (raw ?? {}) as Record<string, unknown>;
  const base: Pair = {
    ...DEFAULT_PAIR_FIELDS,
    id: num(r.id, newId()),
    title: str(r.title, DEFAULT_PAIR_FIELDS.title),
    heading: str(r.heading, DEFAULT_PAIR_FIELDS.heading),
    body: str(r.body, DEFAULT_PAIR_FIELDS.body),
    category: str(r.category, DEFAULT_PAIR_FIELDS.category),
    favorite: r.favorite === true,
    collectionId: typeof r.collectionId === 'number' ? r.collectionId : null,
    headingFont: str(r.headingFont, DEFAULT_PAIR_FIELDS.headingFont),
    bodyFont: str(r.bodyFont, DEFAULT_PAIR_FIELDS.bodyFont),
    size: num(r.size, DEFAULT_PAIR_FIELDS.size),
    weight: num(r.weight, DEFAULT_PAIR_FIELDS.weight),
    leading: num(r.leading, DEFAULT_PAIR_FIELDS.leading),
    tracking: num(r.tracking, DEFAULT_PAIR_FIELDS.tracking),
    rev: Math.max(1, num(r.rev, 1)), // backfill the missing revision number
    updatedAt: num(r.updatedAt, now),
    base: null,
    published: null,
  };
  const rawBase = r.base as Record<string, unknown> | null | undefined;
  if (rawBase && typeof rawBase === 'object') {
    base.base = snapshotOf({...base, ...rawBase} as Pair);
  }
  const rawPub = r.published as Record<string, unknown> | null | undefined;
  if (rawPub && typeof rawPub === 'object') {
    base.published = {
      rev: num(rawPub.rev, base.rev),
      at: num(rawPub.at, now),
      headingFont: str(rawPub.headingFont, base.headingFont),
      bodyFont: str(rawPub.bodyFont, base.bodyFont),
    };
  }
  return base;
}

function normalizeCollection(raw: unknown, now: number, index: number): Collection {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: num(r.id, newId()),
    name: str(r.name, 'Untitled'),
    color: str(r.color, COLLECTION_PALETTE[index % COLLECTION_PALETTE.length]),
    rev: Math.max(1, num(r.rev, 1)),
    updatedAt: num(r.updatedAt, now),
  };
}

function normalizeConflict(raw: unknown, now: number, index: number): Conflict | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.pairId !== 'number' || typeof r.field !== 'string') return null;
  if (!(MERGE_FIELDS as readonly string[]).includes(r.field)) return null;
  return {
    id: str(r.id, `c-import-${now}-${index}`),
    pairId: r.pairId,
    pairTitle: str(r.pairTitle, ''),
    field: r.field as PairField,
    localValue: r.localValue,
    remoteValue: r.remoteValue,
    source: str(r.source, 'import'),
    at: num(r.at, now),
  };
}

/**
 * Upgrade a legacy v1 pair array (localStorage key `type-pairs`) to a v2
 * workspace. Favorites are carried over untouched and collections are rebuilt
 * from the pair categories so nothing is lost. Every migrated pair gets
 * rev 1 and `base = itself`, so two machines migrating the same legacy data
 * still share an ancestor for their first merge.
 */
export function migrateLegacy(rawPairs: unknown[], now: number): Workspace {
  const pairs = rawPairs.map(p => normalizePair(p, now));
  const categories = [...new Set(pairs.map(p => p.category).filter(c => c && c !== 'Untitled'))];
  const collections: Collection[] = categories.map((name, i) => ({
    id: i + 1, name, color: COLLECTION_PALETTE[i % COLLECTION_PALETTE.length], rev: 1, updatedAt: now,
  }));
  for (const p of pairs) {
    const col = collections.find(c => c.name === p.category);
    p.collectionId = col ? col.id : null;
    p.base = snapshotOf(p); // migration is a sync point
  }
  return {version: 2, pairs, collections, conflicts: [], tombstones: [], exportedAt: null};
}

/** First-run seed: the original demo pairings as a proper v2 workspace. */
export function seedWorkspace(now: number): Workspace {
  const ws = migrateLegacy([
    {id: 1, title: 'Editorial calm', heading: 'A slower way to see', body: 'Good typography creates space for ideas to breathe. Pair a confident display face with a quiet, generous text face.', category: 'Editorial', favorite: true},
    {id: 2, title: 'Studio notes', heading: 'Make room for the unexpected', body: 'A thoughtful pairing can add rhythm to even the simplest interface. Try contrast in shape, not just size.', category: 'Portfolio', favorite: false},
    {id: 3, title: 'Field guide', heading: 'Small details, lasting impressions', body: 'Typography is the voice of a page. Find a combination that feels clear, warm and distinctly yours.', category: 'Brand voice', favorite: false},
  ], now);
  const first = ws.pairs[0];
  if (first) first.published = {rev: first.rev, at: now, headingFont: first.headingFont, bodyFont: first.bodyFont};
  return ws;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function serializeWorkspace(ws: Workspace): string {
  return JSON.stringify(ws);
}

function parseWorkspace(raw: string, now: number): Workspace {
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (!data || !Array.isArray(data.pairs)) throw new Error('corrupt workspace');
  return {
    version: 2,
    pairs: data.pairs.map(p => normalizePair(p, now)),
    collections: Array.isArray(data.collections) ? data.collections.map((c, i) => normalizeCollection(c, now, i)) : [],
    conflicts: Array.isArray(data.conflicts) ? data.conflicts.map((c, i) => normalizeConflict(c, now, i)).filter((c): c is Conflict => !!c) : [],
    tombstones: Array.isArray(data.tombstones)
      ? data.tombstones.filter(t => t && typeof t.id === 'number').map(t => ({id: t.id, at: num(t.at, now)}))
      : [],
    exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : null,
  };
}

export function loadWorkspace(now = Date.now()): Workspace {
  let legacy: string | null = null;
  try {
    const main = localStorage.getItem(WORKSPACE_KEY);
    if (main) {
      try { return parseWorkspace(main, now); } catch { /* fall through to backup */ }
    }
    const backup = localStorage.getItem(WORKSPACE_BACKUP_KEY);
    if (backup) {
      try { return parseWorkspace(backup, now); } catch { /* fall through to legacy */ }
    }
    legacy = localStorage.getItem(LEGACY_KEY);
  } catch { /* storage unavailable — seed in memory */ }
  if (legacy) {
    try {
      const raw = JSON.parse(legacy);
      if (Array.isArray(raw) && raw.length) return migrateLegacy(raw, now);
    } catch { /* corrupt legacy — seed */ }
  }
  return seedWorkspace(now);
}

/**
 * Persist as one value per write: the whole workspace lives under a single
 * key, so a batch (e.g. a merge) is never half-written. The previous good
 * blob is kept as a backup for crash recovery.
 */
export function persistWorkspace(ws: Workspace): void {
  const blob = serializeWorkspace(ws);
  try {
    const prev = localStorage.getItem(WORKSPACE_KEY);
    if (prev && prev !== blob) localStorage.setItem(WORKSPACE_BACKUP_KEY, prev);
    localStorage.setItem(WORKSPACE_KEY, blob);
  } catch { /* quota/full — keep working in memory, nothing half-written */ }
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

export interface ExportFile extends ExportData {
  app: 'type-pairer';
  version: 2;
  exportedAt: number;
}

/** Mark the sync point (base = current for every pairing) and build the file. */
export function buildExport(ws: Workspace, now: number): {file: ExportFile; synced: Workspace} {
  const synced: Workspace = {
    ...ws,
    exportedAt: now,
    pairs: ws.pairs.map(p => ({...p, base: snapshotOf(p)})),
  };
  return {
    synced,
    file: {
      app: 'type-pairer',
      version: 2,
      exportedAt: now,
      pairs: synced.pairs,
      collections: synced.collections,
      tombstones: synced.tombstones,
      conflicts: synced.conflicts,
    },
  };
}

/**
 * Parse a teammate's file. Accepts a v2 export or a raw legacy pair array
 * (a teammate still on the old version) — anything else throws, and the
 * caller applies nothing.
 */
export function parseImport(text: string, now: number): ExportData {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON — nothing was imported.');
  }
  if (Array.isArray(data)) {
    const migrated = migrateLegacy(data, now);
    return {pairs: migrated.pairs, collections: migrated.collections, tombstones: [], conflicts: []};
  }
  const obj = data as Record<string, unknown>;
  if (!obj || !Array.isArray(obj.pairs)) {
    throw new Error('That file is not a Type Pairer workspace export — nothing was imported.');
  }
  return {
    pairs: obj.pairs.map(p => normalizePair(p, now)),
    collections: Array.isArray(obj.collections) ? obj.collections.map((c, i) => normalizeCollection(c, now, i)) : [],
    tombstones: Array.isArray(obj.tombstones)
      ? obj.tombstones.filter(t => t && typeof t.id === 'number').map(t => ({id: t.id, at: num(t.at, now)}))
      : [],
    conflicts: Array.isArray(obj.conflicts)
      ? obj.conflicts.map((c, i) => normalizeConflict(c, now, i)).filter((c): c is Conflict => !!c)
      : [],
  };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function mergeCollections(local: Collection[], remote: Collection[]): Collection[] {
  const byId = new Map<number, Collection>();
  for (const c of local) byId.set(c.id, c);
  for (const rc of remote) {
    const lc = byId.get(rc.id);
    if (!lc || rc.updatedAt > lc.updatedAt) byId.set(rc.id, rc);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function sameConflict(a: Conflict, pairId: number, field: PairField, lv: unknown, rv: unknown): boolean {
  return a.pairId === pairId && a.field === field
    && JSON.stringify(a.localValue) === JSON.stringify(lv)
    && JSON.stringify(a.remoteValue) === JSON.stringify(rv);
}

/**
 * Pure three-way merge. Returns the complete next workspace plus a summary,
 * or throws — the caller commits nothing unless this returns.
 */
export function planMerge(local: Workspace, remote: ExportData, source: string, now: number): MergePlan {
  if (!remote || !Array.isArray(remote.pairs)) {
    throw new Error('Invalid merge data — nothing was merged.');
  }
  const remoteById = new Map(remote.pairs.map(p => [p.id, p]));
  const remoteTombs = new Map((remote.tombstones ?? []).map(t => [t.id, t.at]));
  const localTombs = new Map(local.tombstones.map(t => [t.id, t.at]));

  const collections = mergeCollections(local.collections, remote.collections ?? []);
  const collectionIds = new Set(collections.map(c => c.id));

  const conflicts = [...local.conflicts];
  for (const rc of remote.conflicts ?? []) {
    if (!conflicts.some(c => sameConflict(c, rc.pairId, rc.field, rc.localValue, rc.remoteValue))) conflicts.push(rc);
  }
  const newConflicts: Conflict[] = [];
  const pairs: Pair[] = [];
  let added = 0, updated = 0, removed = 0;
  const conflictedPairs = new Set<number>();

  for (const lp of local.pairs) {
    const rp = remoteById.get(lp.id);
    if (!rp) {
      // They deleted it and we have not touched it since → honor the delete.
      const deletedAt = remoteTombs.get(lp.id);
      if (deletedAt !== undefined && deletedAt >= lp.updatedAt) { removed++; continue; }
      pairs.push(lp);
      continue;
    }
    const ancestor = rp.base ?? lp.base;
    const merged: Pair = {...lp};
    let appliedRemote = false;
    let conflicted = false;
    for (const f of MERGE_FIELDS) {
      const lv = lp[f];
      const rv = rp[f];
      if (Object.is(lv, rv)) continue;
      if (ancestor && Object.is(lv, ancestor[f])) {
        (merged as unknown as Record<string, unknown>)[f] = rv; // only they changed it
        appliedRemote = true;
      } else if (ancestor && Object.is(rv, ancestor[f])) {
        // only we changed it — keep ours
      } else {
        // Both changed the same field (or there is no common ancestor):
        // keep ours applied, keep theirs as a recorded conflict.
        conflicted = true;
        conflictedPairs.add(lp.id);
        const exists = conflicts.some(c => sameConflict(c, lp.id, f, lv, rv));
        if (!exists) {
          const c: Conflict = {
            id: `c-${lp.id}-${f}-${now}-${newConflicts.length}`,
            pairId: lp.id, pairTitle: lp.title, field: f,
            localValue: lv, remoteValue: rv, source, at: now,
          };
          conflicts.push(c);
          newConflicts.push(c);
        }
      }
    }
    if (appliedRemote) {
      merged.rev = Math.max(lp.rev, rp.rev) + 1;
      merged.updatedAt = now;
      updated++;
    }
    // Only advance the sync point when the pair merged cleanly; otherwise the
    // next import of the same file must reproduce the same conflict.
    merged.base = appliedRemote && !conflicted ? snapshotOf(merged) : lp.base;
    pairs.push(merged);
  }

  for (const rp of remote.pairs) {
    if (local.pairs.some(p => p.id === rp.id)) continue;
    const deletedAt = localTombs.get(rp.id);
    if (deletedAt !== undefined && deletedAt >= rp.updatedAt) continue; // we deleted it after their last edit
    pairs.push({...rp});
    added++;
  }

  const surviving = new Set(pairs.map(p => p.id));
  const tombById = new Map<number, number>();
  for (const t of [...local.tombstones, ...(remote.tombstones ?? [])]) {
    tombById.set(t.id, Math.max(tombById.get(t.id) ?? 0, t.at));
  }
  const tombstones = [...tombById.entries()]
    .filter(([id]) => !surviving.has(id))
    .map(([id, at]) => ({id, at}));

  // A pairing can only live in one collection — drop dangling references.
  for (const p of pairs) {
    if (p.collectionId !== null && !collectionIds.has(p.collectionId)) p.collectionId = null;
  }

  const keptConflicts = conflicts.filter(c => surviving.has(c.pairId));
  return {
    workspace: {...local, pairs, collections, conflicts: keptConflicts, tombstones},
    summary: {added, updated, removed, conflicting: conflictedPairs.size},
    newConflicts,
  };
}

/** Resolve a conflict by keeping our value or taking theirs. */
export function resolveConflict(ws: Workspace, conflictId: string, choice: 'local' | 'remote', now: number): Workspace {
  const c = ws.conflicts.find(x => x.id === conflictId);
  if (!c) return ws;
  const conflicts = ws.conflicts.filter(x => x.id !== conflictId);
  if (choice === 'local') return {...ws, conflicts};
  return {
    ...ws,
    conflicts,
    pairs: ws.pairs.map(p => p.id === c.pairId
      ? {...p, [c.field]: c.remoteValue, rev: p.rev + 1, updatedAt: now}
      : p),
  };
}

// ---------------------------------------------------------------------------
// CSS export — carries publish status and conflict sources
// ---------------------------------------------------------------------------

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

export function buildCss(pair: Pair, pairConflicts: Conflict[], collectionName: string | null): string {
  const lines: string[] = [`/* ${pair.title} — rev ${pair.rev} */`];
  const status = pairStatus(pair);
  if (status === 'stale') {
    lines.push(`/* Status: NEEDS CONFIRMATION — heading/body font changed after publish (published rev ${pair.published!.rev}) */`);
  } else if (status === 'published') {
    lines.push(`/* Status: published (rev ${pair.published!.rev}) */`);
  } else {
    lines.push('/* Status: draft — not yet published */');
  }
  if (collectionName) lines.push(`/* Collection: ${collectionName} */`);
  for (const c of pairConflicts) {
    lines.push(`/* Conflict from "${c.source}": ${FIELD_LABELS[c.field]} — yours ${fmtVal(c.localValue)}, theirs ${fmtVal(c.remoteValue)} (unresolved) */`);
  }
  lines.push(
    `.heading { font-family: '${pair.headingFont}'; font-size: ${pair.size}px; font-weight: ${pair.weight}; letter-spacing: ${pair.tracking}px; }`,
    `.body { font-family: '${pair.bodyFont}'; line-height: ${pair.leading}; letter-spacing: ${pair.tracking / 2}px; }`,
  );
  return lines.join('\n');
}
