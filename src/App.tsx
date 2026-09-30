import {useEffect, useRef, useState} from 'react';
import {
  AlertTriangle, BookOpen, ChevronDown, Download, GitMerge, Grid3X3, Heart,
  Plus, Settings2, SlidersHorizontal, Star, Trash2, Type, Upload,
} from 'lucide-react';
import {
  buildCss, buildExport, Conflict, FIELD_LABELS, loadWorkspace, MergePlan, newId,
  Pair, PairField, PairSnapshot, pairStatus, parseImport, persistWorkspace, planMerge,
  resolveConflict, Workspace,
} from './workspace';

const fonts = ['Fraunces', 'DM Sans', 'Space Grotesk', 'Newsreader', 'IBM Plex Sans', 'Playfair Display'];

const initialWorkspace = loadWorkspace(); // loaded (and migrated) once at startup

type Filter = {kind: 'all'} | {kind: 'favorites'} | {kind: 'attention'} | {kind: 'collection'; id: number};

function download(name: string, text: string, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function App() {
  const [ws, setWs] = useState<Workspace>(initialWorkspace);
  const [selected, setSelected] = useState<number>(initialWorkspace.pairs[0]?.id ?? 0);
  const [filter, setFilter] = useState<Filter>({kind: 'all'});
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [showAddCollection, setShowAddCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [pendingMerge, setPendingMerge] = useState<{plan: MergePlan; source: string} | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // One state commit → one storage write of the whole workspace. A merge is
  // therefore all-or-nothing; a failed merge never leaves half a batch.
  useEffect(() => persistWorkspace(ws), [ws]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const conflictsFor = (pairId: number) => ws.conflicts.filter(c => c.pairId === pairId);
  const attentionCount = ws.pairs.filter(p => pairStatus(p) === 'stale' || conflictsFor(p.id).length > 0).length;
  const collectionName = (id: number | null) => ws.collections.find(c => c.id === id)?.name ?? null;

  const visiblePairs = ws.pairs.filter(p => {
    if (filter.kind === 'favorites') return p.favorite;
    if (filter.kind === 'attention') return pairStatus(p) === 'stale' || conflictsFor(p.id).length > 0;
    if (filter.kind === 'collection') return p.collectionId === filter.id;
    return true;
  });

  const current = ws.pairs.find(p => p.id === selected) ?? ws.pairs[0];
  const currentConflicts = current ? conflictsFor(current.id) : [];
  const currentStatus = current ? pairStatus(current) : 'draft';

  // ---- local edits -------------------------------------------------------

  const updatePair = (id: number, patch: Partial<PairSnapshot>) =>
    setWs(w => ({
      ...w,
      pairs: w.pairs.map(p => p.id === id ? {...p, ...patch, rev: p.rev + 1, updatedAt: Date.now()} : p),
    }));

  const createPair = () => {
    if (!newTitle.trim()) return;
    const id = newId();
    const now = Date.now();
    const pair: Pair = {
      id, title: newTitle.trim(), heading: 'Your new headline',
      body: 'Start with a sentence that lets your type pairing show its character.',
      category: 'Untitled', favorite: false,
      collectionId: filter.kind === 'collection' ? filter.id : null,
      headingFont: 'Fraunces', bodyFont: 'DM Sans', size: 46, weight: 600, leading: 1.25, tracking: 0,
      rev: 1, updatedAt: now, base: null, published: null,
    };
    setWs(w => ({...w, pairs: [...w.pairs, pair]}));
    setSelected(id);
    setNewTitle('');
    setShowAdd(false);
  };

  const deletePair = (id: number) => {
    setWs(w => ({
      ...w,
      pairs: w.pairs.filter(p => p.id !== id),
      conflicts: w.conflicts.filter(c => c.pairId !== id),
      tombstones: [...w.tombstones.filter(t => t.id !== id), {id, at: Date.now()}],
    }));
    setSelected(ws.pairs.find(p => p.id !== id)?.id ?? 0);
  };

  const publish = (id: number) =>
    setWs(w => ({
      ...w,
      pairs: w.pairs.map(p => p.id === id
        ? {...p, published: {rev: p.rev, at: Date.now(), headingFont: p.headingFont, bodyFont: p.bodyFont}}
        : p),
    }));

  const createCollection = () => {
    if (!newCollectionName.trim()) return;
    const now = Date.now();
    const col = {
      id: newId(), name: newCollectionName.trim(),
      color: ['#e8b7a0', '#9fc9be', '#b4add8', '#e5c07b', '#8fb8d8'][ws.collections.length % 5],
      rev: 1, updatedAt: now,
    };
    setWs(w => ({...w, collections: [...w.collections, col]}));
    setNewCollectionName('');
    setShowAddCollection(false);
  };

  // ---- merge station -----------------------------------------------------

  const exportWorkspace = () => {
    const {file, synced} = buildExport(ws, Date.now());
    setWs(synced); // exporting marks the sync point (base = current)
    download(`type-pairer-workspace-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(file, null, 2), 'application/json');
    setToast('Workspace exported — share the file with your team.');
  };

  const onImportFile = async (file: File) => {
    setMergeError(null);
    try {
      const remote = parseImport(await file.text(), Date.now());
      // Pure planning step: either we get a complete next workspace or nothing happens.
      const plan = planMerge(ws, remote, file.name, Date.now());
      setPendingMerge({plan, source: file.name});
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : 'Could not read that file — nothing was imported.');
    }
  };

  const applyMerge = () => {
    if (!pendingMerge) return;
    const {plan, source} = pendingMerge;
    setWs(plan.workspace); // single commit — the whole batch lands at once
    setPendingMerge(null);
    const s = plan.summary;
    setToast(`Merged “${source}”: ${s.added} added, ${s.updated} updated, ${s.removed} removed, ${s.conflicting} with conflicts.`);
  };

  const resolve = (conflictId: string, choice: 'local' | 'remote') =>
    setWs(w => resolveConflict(w, conflictId, choice, Date.now()));

  // ---- export CSS ----------------------------------------------------------

  const exportCss = () => {
    if (!current) return;
    download('type-pair.css', buildCss(current, currentConflicts, collectionName(current.collectionId)), 'text/css');
  };

  const fmtValue = (field: PairField, v: unknown): string => {
    if (field === 'collectionId') return collectionName(typeof v === 'number' ? v : null) ?? 'No collection';
    if (typeof v === 'boolean') return v ? 'On' : 'Off';
    if (v === null || v === undefined) return '—';
    return String(v);
  };

  const statusBadge = (p: Pair) => {
    const st = pairStatus(p);
    if (st === 'stale') return <span className="badge warn">Needs confirmation</span>;
    if (st === 'published') return <span className="badge ok">Published</span>;
    return null;
  };

  return (
    <div className="app">
      <aside>
        <div className="brand">
          <div className="brand-mark"><Type size={18}/></div>
          <div><b>Type Pairer</b><small>FIND YOUR VOICE</small></div>
        </div>

        <div className="nav-section">
          <span>LIBRARY</span>
          <button className={filter.kind === 'all' ? 'nav active' : 'nav'} onClick={() => setFilter({kind: 'all'})}>
            <Grid3X3 size={16}/>All pairings <b>{ws.pairs.length}</b>
          </button>
          <button className={filter.kind === 'favorites' ? 'nav active' : 'nav'} onClick={() => setFilter({kind: 'favorites'})}>
            <Heart size={16}/>Favorites <b>{ws.pairs.filter(p => p.favorite).length}</b>
          </button>
          <button className={filter.kind === 'attention' ? 'nav active' : 'nav'} onClick={() => setFilter({kind: 'attention'})}>
            <AlertTriangle size={16}/>Needs review <b>{attentionCount}</b>
          </button>
        </div>

        <div className="saved">
          <div className="saved-head">
            <span>COLLECTIONS</span>
            <button onClick={() => setShowAddCollection(true)}><Plus size={14}/></button>
          </div>
          {ws.collections.map(c => (
            <button
              key={c.id}
              className={filter.kind === 'collection' && filter.id === c.id ? 'collection active' : 'collection'}
              onClick={() => setFilter({kind: 'collection', id: c.id})}
            >
              <i style={{background: c.color}}/>{c.name}
              <b>{ws.pairs.filter(p => p.collectionId === c.id).length}</b>
            </button>
          ))}
          {ws.collections.length === 0 && <p className="aside-hint">No collections yet.</p>}
        </div>

        <div className="saved">
          <div className="saved-head"><span>MERGE STATION</span></div>
          <button className="nav" onClick={exportWorkspace}><Upload size={16}/>Export workspace</button>
          <button className="nav" onClick={() => fileRef.current?.click()}>
            <GitMerge size={16}/>Import &amp; merge
            {ws.conflicts.length > 0 && <b className="pill">{ws.conflicts.length}</b>}
          </button>
          <p className="aside-hint">Export, tune offline, then merge — conflicts keep both versions.</p>
        </div>

        <div className="aside-foot">
          <button className="nav"><Settings2 size={16}/>Preferences</button>
          <div className="profile">
            <div className="avatar">YL</div>
            <div><b>Yuki Lin</b><small>Design workspace</small></div>
            <ChevronDown size={14}/>
          </div>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <div className="crumb">TYPE LIBRARY / <b>PAIRING STUDIO</b></div>
            <h1>Find the right conversation.</h1>
            <p>Explore combinations, tune the details, and merge the team's offline work without losing a beat.</p>
          </div>
          <div className="actions">
            <button className="outline" onClick={exportCss}><Download size={15}/>Copy CSS</button>
            <button className="outline" onClick={exportWorkspace}><Upload size={15}/>Export</button>
            <button className="primary" onClick={() => setShowAdd(true)}><Plus size={16}/>New pairing</button>
          </div>
        </header>

        <div className="layout">
          <section className="gallery">
            <div className="gallery-head">
              <div>
                <h2>Saved pairings</h2>
                <span>{visiblePairs.length} of {ws.pairs.length} compositions</span>
              </div>
              <div className="view-toggle">
                <button className="on"><Grid3X3 size={14}/></button>
                <button><BookOpen size={14}/></button>
              </div>
            </div>
            <div className="pair-list">
              {visiblePairs.map(p => {
                const pConflicts = conflictsFor(p.id);
                return (
                  <button key={p.id} className={current?.id === p.id ? 'pair selected' : 'pair'} onClick={() => setSelected(p.id)}>
                    <div className="pair-top">
                      <span>{collectionName(p.collectionId) ?? p.category}</span>
                      <Heart size={15} fill={p.favorite ? '#e88769' : 'none'} color={p.favorite ? '#e88769' : '#aeb5b7'}/>
                    </div>
                    <strong style={{fontFamily: p.headingFont}}>{p.heading}</strong>
                    <p style={{fontFamily: p.bodyFont}}>{p.body}</p>
                    {(statusBadge(p) || pConflicts.length > 0) && (
                      <div className="badges">
                        {statusBadge(p)}
                        {pConflicts.length > 0 && (
                          <span className="badge danger" title={pConflicts.map(c => `${FIELD_LABELS[c.field]} (from ${c.source})`).join(', ')}>
                            Conflict · {pConflicts[0].source}{pConflicts.length > 1 ? ` +${pConflicts.length - 1}` : ''}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="pair-foot">
                      <span>{p.title} · rev {p.rev}</span>
                      <small>Open canvas →</small>
                    </div>
                  </button>
                );
              })}
              {visiblePairs.length === 0 && <p className="empty">Nothing here yet.</p>}
            </div>
          </section>

          {current && (
            <section className="studio">
              <div className="studio-head">
                <div>
                  <span>PAIRING CANVAS</span>
                  <h2>{current.title}</h2>
                </div>
                <button className="favorite" onClick={() => updatePair(current.id, {favorite: !current.favorite})}>
                  <Star size={16} fill={current.favorite ? '#e5a35e' : 'none'} color={current.favorite ? '#e5a35e' : '#98a4a7'}/>
                </button>
              </div>

              <div className="canvas">
                <div className="canvas-bar">
                  <span>PREVIEW</span>
                  <div><button>Desktop</button><button>Tablet</button><button>Mobile</button></div>
                </div>
                <div className="preview">
                  <span className="preview-kicker">A NOTE ON TYPE</span>
                  <h3 style={{fontFamily: current.headingFont, fontSize: `${current.size}px`, fontWeight: current.weight, letterSpacing: `${current.tracking}px`, lineHeight: 1.05}}>{current.heading}</h3>
                  <p style={{fontFamily: current.bodyFont, lineHeight: current.leading, letterSpacing: `${current.tracking / 2}px`}}>{current.body}</p>
                  <div className="preview-rule"/>
                  <span className="preview-meta">PAIRING {String(current.id).slice(-4).padStart(4, '0')} · {current.category.toUpperCase()}</span>
                </div>
              </div>

              <div className="publish-bar">
                {currentStatus === 'stale' && (
                  <>
                    <span className="badge warn">Needs confirmation</span>
                    <span className="publish-note">Heading/body font changed after publish — the old published version (rev {current.published!.rev}) is no longer valid.</span>
                  </>
                )}
                {currentStatus === 'published' && (
                  <>
                    <span className="badge ok">Published</span>
                    <span className="publish-note">Published at rev {current.published!.rev} · {new Date(current.published!.at).toLocaleDateString()}</span>
                  </>
                )}
                {currentStatus === 'draft' && (
                  <>
                    <span className="badge muted">Draft</span>
                    <span className="publish-note">Not published yet.</span>
                  </>
                )}
                <span className="spacer"/>
                <button
                  className={currentStatus === 'stale' ? 'publish-btn warn' : 'publish-btn'}
                  disabled={currentStatus === 'published'}
                  onClick={() => publish(current.id)}
                >
                  {currentStatus === 'stale' ? 'Re-confirm publish' : currentStatus === 'published' ? 'Published ✓' : 'Publish'}
                </button>
              </div>

              <div className="controls">
                <div className="control-head">
                  <div><span>TYPE CONTROLS</span><h3>Fine tune your pairing</h3></div>
                  <SlidersHorizontal size={17}/>
                </div>
                <div className="font-row">
                  <label>Heading font
                    <select value={current.headingFont} onChange={e => updatePair(current.id, {headingFont: e.target.value})}>
                      {fonts.map(f => <option key={f}>{f}</option>)}
                    </select>
                  </label>
                  <label>Body font
                    <select value={current.bodyFont} onChange={e => updatePair(current.id, {bodyFont: e.target.value})}>
                      {fonts.map(f => <option key={f}>{f}</option>)}
                    </select>
                  </label>
                </div>
                <div className="range-row">
                  <label>Size <b>{current.size}px</b>
                    <input type="range" min="28" max="76" value={current.size} onChange={e => updatePair(current.id, {size: Number(e.target.value)})}/>
                  </label>
                  <label>Weight <b>{current.weight}</b>
                    <input type="range" min="300" max="800" step="100" value={current.weight} onChange={e => updatePair(current.id, {weight: Number(e.target.value)})}/>
                  </label>
                </div>
                <div className="range-row">
                  <label>Line height <b>{current.leading.toFixed(2)}</b>
                    <input type="range" min="1" max="1.8" step=".05" value={current.leading} onChange={e => updatePair(current.id, {leading: Number(e.target.value)})}/>
                  </label>
                  <label>Letter spacing <b>{current.tracking}px</b>
                    <input type="range" min="-1" max="3" step=".5" value={current.tracking} onChange={e => updatePair(current.id, {tracking: Number(e.target.value)})}/>
                  </label>
                </div>
                <div className="font-row">
                  <label>Collection — a pairing lives in one collection only
                    <select
                      value={current.collectionId ?? ''}
                      onChange={e => updatePair(current.id, {collectionId: e.target.value === '' ? null : Number(e.target.value)})}
                    >
                      <option value="">No collection</option>
                      {ws.collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </label>
                  <label>Category
                    <select value={current.category} onChange={e => updatePair(current.id, {category: e.target.value})}>
                      {['Untitled', 'Editorial', 'Portfolio', 'Brand voice'].map(c => <option key={c}>{c}</option>)}
                    </select>
                  </label>
                </div>
              </div>

              {currentConflicts.length > 0 && (
                <div className="conflicts">
                  <div className="conflicts-head">
                    <AlertTriangle size={15}/>
                    <div>
                      <b>{currentConflicts.length} merge conflict{currentConflicts.length > 1 ? 's' : ''}</b>
                      <span>Both versions are kept — yours is applied, theirs is stored with its source.</span>
                    </div>
                  </div>
                  {currentConflicts.map(c => (
                    <div className="conflict" key={c.id}>
                      <div className="conflict-field">{FIELD_LABELS[c.field]}</div>
                      <div className="conflict-versions">
                        <div className="ver"><span>Yours · applied</span><b>{fmtValue(c.field, c.localValue)}</b></div>
                        <div className="ver theirs"><span>Theirs · {c.source}</span><b>{fmtValue(c.field, c.remoteValue)}</b></div>
                      </div>
                      <div className="conflict-actions">
                        <button className="chip-btn" onClick={() => resolve(c.id, 'local')}>Keep mine</button>
                        <button className="chip-btn primary-chip" onClick={() => resolve(c.id, 'remote')}>Use theirs</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="studio-foot">
                <button className="delete" onClick={() => deletePair(current.id)}><Trash2 size={15}/>Delete pairing</button>
                <button className="save" onClick={() => setToast('Saved locally — every edit is persisted automatically.')}><CheckIcon/>Saved locally</button>
              </div>
            </section>
          )}
        </div>
      </main>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) void onImportFile(f);
          e.target.value = '';
        }}
      />

      {showAdd && (
        <div className="backdrop" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>New pairing</h2>
            <label>Pairing name
              <input autoFocus value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="e.g. Quiet confidence"/>
            </label>
            <div className="modal-actions">
              <button className="outline" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="primary" onClick={createPair}>Create pairing</button>
            </div>
          </div>
        </div>
      )}

      {showAddCollection && (
        <div className="backdrop" onClick={() => setShowAddCollection(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>New collection</h2>
            <label>Collection name
              <input autoFocus value={newCollectionName} onChange={e => setNewCollectionName(e.target.value)} placeholder="e.g. Marketing site"/>
            </label>
            <div className="modal-actions">
              <button className="outline" onClick={() => setShowAddCollection(false)}>Cancel</button>
              <button className="primary" onClick={createCollection}>Create collection</button>
            </div>
          </div>
        </div>
      )}

      {pendingMerge && (
        <div className="backdrop" onClick={() => setPendingMerge(null)}>
          <div className="modal merge-modal" onClick={e => e.stopPropagation()}>
            <h2>Merge “{pendingMerge.source}”</h2>
            <div className="merge-summary">
              <span className="stat-chip">+{pendingMerge.plan.summary.added} added</span>
              <span className="stat-chip">~{pendingMerge.plan.summary.updated} updated</span>
              <span className="stat-chip">−{pendingMerge.plan.summary.removed} removed</span>
              <span className={pendingMerge.plan.summary.conflicting > 0 ? 'stat-chip warn' : 'stat-chip'}>
                !{pendingMerge.plan.summary.conflicting} conflicted
              </span>
            </div>
            {pendingMerge.plan.newConflicts.length > 0 && (
              <div className="conflict-preview">
                {pendingMerge.plan.newConflicts.slice(0, 6).map((c: Conflict) => (
                  <div className="conflict-line" key={c.id}>
                    <b>{c.pairTitle}</b> · {FIELD_LABELS[c.field]} — yours <b>{fmtValue(c.field, c.localValue)}</b>, theirs <b>{fmtValue(c.field, c.remoteValue)}</b>
                  </div>
                ))}
                {pendingMerge.plan.newConflicts.length > 6 && (
                  <div className="conflict-line">…and {pendingMerge.plan.newConflicts.length - 6} more</div>
                )}
              </div>
            )}
            <p className="merge-note">
              Conflicting fields keep both versions: yours stays applied, theirs is stored with “{pendingMerge.source}”
              as its source for review. The merge is applied all at once — if anything fails, nothing is written and
              you can simply retry.
            </p>
            <div className="modal-actions">
              <button className="outline" onClick={() => setPendingMerge(null)}>Cancel</button>
              <button className="primary" onClick={applyMerge}>Apply merge</button>
            </div>
          </div>
        </div>
      )}

      {mergeError && (
        <div className="backdrop" onClick={() => setMergeError(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Merge failed</h2>
            <p className="merge-note">{mergeError} Your workspace was not touched — fix the file and try again.</p>
            <div className="modal-actions">
              <button className="primary" onClick={() => setMergeError(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function CheckIcon() {
  return <span className="check">✓</span>;
}
