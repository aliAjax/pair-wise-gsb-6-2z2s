import React, {useRef, useState} from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Download,
  FileUp,
  FolderPlus,
  Grid3X3,
  Heart,
  History,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Star,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import {FIELD_LABELS, FONT_FIELDS, fontStatus, pendingReasons} from './core/engine';
import type {FieldKey, Pair, Workspace} from './core/types';
import {useWorkspace} from './core/useWorkspace';
import ConflictPanel, {ResolveChoice} from './components/ConflictPanel';

const FONTS = ['Fraunces', 'DM Sans', 'Space Grotesk', 'Newsreader', 'IBM Plex Sans', 'Playfair Display'];

type Filter = {kind: 'all'} | {kind: 'favorites'} | {kind: 'collection'; id: string};

export default function App(): React.ReactElement {
  const api = useWorkspace();
  const [selectedId, setSelectedId] = useState<string>('p1');
  const [filter, setFilter] = useState<Filter>({kind: 'all'});
  const [showAdd, setShowAdd] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  if (!api.ready || !api.ws) {
    return <div className="boot">正在载入离线工作区…</div>;
  }
  const ws: Workspace = api.ws;
  const current = ws.pairs.find((p) => p.id === selectedId) ?? ws.pairs[0];

  const visible = ws.pairs.filter((p) => {
    if (filter.kind === 'favorites') return p.favorite;
    if (filter.kind === 'collection') return p.collectionId === filter.id;
    return true;
  });

  const counts = {
    all: ws.pairs.length,
    fav: ws.pairs.filter((p) => p.favorite).length,
    conflicts: ws.pairs.reduce((n, p) => n + p.conflicts.length, 0),
    pending: ws.pairs.filter((p) => fontStatus(p) !== 'current' || p.conflicts.some((c) => FONT_FIELDS.includes(c.field))).length,
  };

  const collectionName = (id: string | null): string =>
    id === null ? '未归入合集' : ws.collections.find((c) => c.id === id)?.name ?? id;

  const edit = (field: FieldKey, value: unknown): void => {
    if (current) api.updateField(current.id, field, value);
  };

  const addCollection = (): void => {
    const name = newCollectionName.trim();
    if (!name) return;
    api.createCollection(name);
    setNewCollectionName('');
  };

  return (
    <div className="app">
      <aside>
        <div className="brand">
          <div className="brand-mark"><Type size={18}/></div>
          <div>
            <b>Type Pairer</b>
            <small>OFFLINE MERGE DESK</small>
          </div>
        </div>

        <div className="nav-section">
          <span>资料库</span>
          <button className={`nav ${filter.kind === 'all' ? 'active' : ''}`} onClick={() => setFilter({kind: 'all'})}>
            <Grid3X3 size={16}/>全部配对 <b>{counts.all}</b>
          </button>
          <button className={`nav ${filter.kind === 'favorites' ? 'active' : ''}`} onClick={() => setFilter({kind: 'favorites'})}>
            <Heart size={16}/>收藏 <b>{counts.fav}</b>
          </button>
          {counts.conflicts > 0 && (
            <div className="nav alert">
              <AlertTriangle size={15}/>待解决冲突 <b>{counts.conflicts}</b>
            </div>
          )}
          {counts.pending > 0 && (
            <div className="nav pending">
              <ShieldCheck size={15}/>待确认发布 <b>{counts.pending}</b>
            </div>
          )}
        </div>

        <div className="saved">
          <div className="saved-head">
            <span>合集（配对单归属）</span>
            <button onClick={() => (document.getElementById('new-col-input') as HTMLInputElement)?.focus()} title="新建合集">
              <Plus size={14}/>
            </button>
          </div>
          <div className="new-col">
            <FolderPlus size={13}/>
            <input
              id="new-col-input"
              value={newCollectionName}
              placeholder="新合集名称"
              onChange={(e) => setNewCollectionName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCollection()}
            />
          </div>
          {ws.collections.map((c) => {
            const n = ws.pairs.filter((p) => p.collectionId === c.id).length;
            return (
              <button
                key={c.id}
                className={`collection ${filter.kind === 'collection' && filter.id === c.id ? 'active' : ''}`}
                onClick={() => setFilter({kind: 'collection', id: c.id})}
              >
                <i style={{background: c.color}}/>
                {c.name} <b>{n}</b>
              </button>
            );
          })}
        </div>

        <div className="merge-desk">
          <span>离线合并台</span>
          <button onClick={api.exportBundleFile} className="desk-btn export">
            <Send size={14}/>导出我的改动包
          </button>
          <button onClick={() => setShowMerge(true)} className="desk-btn import">
            <FileUp size={14}/>导入同事改动包
          </button>
          <button onClick={() => setShowLog(true)} className="desk-btn ghost">
            <History size={14}/>合并与回滚记录
          </button>
          <small>改动包内含三方合并基线，可离线多跳续传；同一包不会被并入两次。</small>
        </div>

        <div className="aside-foot">
          <button className="nav"><Settings2 size={16}/>工作区偏好</button>
          <div className="profile">
            <div className="avatar">{ws.editorName.slice(0, 1)}</div>
            <div>
              <b>{ws.editorName}</b>
              <small>离线编辑 · 原子提交</small>
            </div>
            <ChevronDown size={14}/>
          </div>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <div className="crumb">TYPE LIBRARY / <b>合并工作台</b></div>
            <h1>离线各改各的，合上也不丢字。</h1>
            <p>字段级三方合并：只一边改自动并入，两边同改保留两版并标冲突来源；字体一变，旧发布立即标记待确认。</p>
          </div>
          <div className="actions">
            <button className="outline" onClick={api.exportBundleFile}><Download size={15}/>导出改动包</button>
            <button className="outline" onClick={() => setShowMerge(true)}><FileUp size={15}/>导入合并</button>
            <button className="primary" onClick={() => setShowAdd(true)}><Plus size={16}/>新建配对</button>
          </div>
        </header>

        {api.recoveredStage && (
          <div className="recovery-banner">
            <RefreshCw size={15}/>
            上次合并在写入阶段失败，暂存的半成品已丢弃，正式数据完好。请重新导入改动包。
            <button onClick={api.clearRecoveryFlag}>知道了</button>
          </div>
        )}

        <div className="layout">
          <section className="gallery">
            <div className="gallery-head">
              <div>
                <h2>{filter.kind === 'favorites' ? '收藏的配对' : filter.kind === 'collection' ? collectionName(filter.id) : '全部配对'}</h2>
                <span>{visible.length} 条 · 修订号即合并代次</span>
              </div>
              <div className="view-toggle">
                <button className="on"><Grid3X3 size={14}/></button>
                <button><BookOpen size={14}/></button>
              </div>
            </div>
            <div className="pair-list">
              {visible.map((p) => <PairCard key={p.id} pair={p} selected={current?.id === p.id} collection={collectionName(p.collectionId)} onSelect={() => setSelectedId(p.id)}/>)}
              {visible.length === 0 && <div className="empty">这个分组里还没有配对。</div>}
            </div>
          </section>

          {current && (
            <Studio
              pair={current}
              collectionName={collectionName(current.collectionId)}
              collections={ws.collections}
              onEdit={edit}
              onFav={(v) => api.setFavorite(current.id, v)}
              onMove={(id) => api.moveToCollection(current.id, id)}
              onPublish={() => api.publish(current.id)}
              onResolve={(field, choice) => api.resolve(current.id, field, choice)}
              onDelete={() => {
                api.deletePair(current.id);
              }}
              onExportCss={() => api.downloadCss(current.id)}
            />
          )}
        </div>
      </main>

      {showAdd && (
        <AddPairModal
          collections={ws.collections}
          onClose={() => setShowAdd(false)}
          onCreate={(title, category, collectionId) => {
            const id = api.createPair({title, category, collectionId});
            setSelectedId(id);
            setShowAdd(false);
          }}
        />
      )}

      {showMerge && (
        <MergeModal
          onClose={() => setShowMerge(false)}
          onImport={(text, simulateFailure) => api.importBundleText(text, {simulateCommitFailure: simulateFailure})}
          fileRef={fileRef}
        />
      )}

      {showLog && <LogModal ws={ws} onClose={() => setShowLog(false)}/>}

      {api.toast && (
        <div className={`toast ${api.toast.kind}`}>
          {api.toast.kind === 'ok' ? <CheckCircle2 size={16}/> : <AlertTriangle size={16}/>}
          <span>{api.toast.text}</span>
          <button onClick={api.dismissToast}><X size={14}/></button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 配对卡片：显示修订号、发布状态、冲突数
// ---------------------------------------------------------------------------

function PairCard({pair, selected, collection, onSelect}: {
  pair: Pair;
  selected: boolean;
  collection: string;
  onSelect: () => void;
}): React.ReactElement {
  const status = fontStatus(pair);
  return (
    <button className={`pair ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="pair-top">
        <span>{pair.category} · r{pair.revision}</span>
        <Heart size={15} fill={pair.favorite ? '#e88769' : 'none'} color={pair.favorite ? '#e88769' : '#aeb5b7'}/>
      </div>
      <strong style={{fontFamily: `'${pair.headingFont}', serif`}}>{pair.heading}</strong>
      <p style={{fontFamily: `'${pair.bodyFont}', sans-serif`}}>{pair.body}</p>
      <div className="badges">
        {pair.conflicts.length > 0 && <span className="badge conflict"><AlertTriangle size={11}/>冲突 {pair.conflicts.length}</span>}
        {status === 'stale' && <span className="badge stale"><RefreshCw size={11}/>待重新确认</span>}
        {status === 'unpublished' && <span className="badge unpublished"><ShieldCheck size={11}/>待确认</span>}
        {status === 'current' && <span className="badge current"><CheckCircle2 size={11}/>已确认 r{pair.published!.revision}</span>}
      </div>
      <div className="pair-foot">
        <span>{pair.title} · {collection}</span>
        <small>打开合并台 →</small>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 右侧工作区
// ---------------------------------------------------------------------------

function Studio(props: {
  pair: Pair;
  collectionName: string;
  collections: Workspace['collections'];
  onEdit: (field: FieldKey, value: unknown) => void;
  onFav: (v: boolean) => void;
  onMove: (id: string | null) => void;
  onPublish: () => void;
  onResolve: (field: FieldKey, choice: ResolveChoice) => void;
  onDelete: () => void;
  onExportCss: () => void;
}): React.ReactElement {
  const {pair: p} = props;
  const status = fontStatus(p);
  const reasons = pendingReasons(p);
  return (
    <section className="studio">
      <div className="studio-head">
        <div className="studio-title">
          <span>配对画布 · 修订 r{p.revision}</span>
          <input className="title-input" value={p.title} onChange={(e) => props.onEdit('title', e.target.value)}/>
        </div>
        <button className="favorite" onClick={() => props.onFav(!p.favorite)} title="收藏（不升修订号）">
          <Star size={16} fill={p.favorite ? '#e5a35e' : 'none'} color={p.favorite ? '#e5a35e' : '#98a4a7'}/>
        </button>
      </div>

      {/* 发布状态条：页面必须显示待确认与冲突来源 */}
      <div className={`publish-bar ${status} ${p.conflicts.length ? 'has-conflict' : ''}`}>
        {status === 'current' && <><CheckCircle2 size={15}/><b>已确认发布</b><span>当前确认版本 r{p.published!.revision}，字体 {p.published!.headingFont} + {p.published!.bodyFont}</span></>}
        {status === 'stale' && <><RefreshCw size={15}/><b>待重新确认</b><span>标题/正文字体已变化，旧发布版本 r{p.published!.revision}（{p.published!.headingFont} + {p.published!.bodyFont}）已失效</span><button onClick={props.onPublish}>重新确认发布</button></>}
        {status === 'unpublished' && <><ShieldCheck size={15}/><b>待确认</b><span>尚未确认发布，导出稿只作预览</span><button onClick={props.onPublish}>确认发布</button></>}
      </div>
      {reasons.length > 0 && status !== 'current' && (
        <ul className="reason-list">{reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      )}

      <div className="canvas">
        <div className="canvas-bar">
          <span>实时预览（当前工作值{ p.conflicts.length ? '＝本机版' : ''}）</span>
          <div><button className="on">Desktop</button><button>Tablet</button><button>Mobile</button></div>
        </div>
        <div className="preview">
          <span className="preview-kicker">{p.category} · {props.collectionName}</span>
          <h3 style={{fontFamily: `'${p.headingFont}', serif`, fontSize: `${p.size}px`, fontWeight: p.weight, letterSpacing: `${p.tracking}px`, lineHeight: 1.05}}>{p.heading}</h3>
          <p style={{fontFamily: `'${p.bodyFont}', sans-serif`, lineHeight: p.leading, letterSpacing: `${p.tracking / 2}px`}}>{p.body}</p>
          <div className="preview-rule"/>
          <span className="preview-meta">
            {p.id.toUpperCase()} · r{p.revision}
            {p.published ? ` · 发布 r${p.published.revision}` : ''} · 最后修改 {p.updatedBy}
          </span>
        </div>
      </div>

      {p.conflicts.length > 0 && (
        <ConflictPanel conflicts={p.conflicts} collections={props.collections} onResolve={props.onResolve}/>
      )}

      <div className="controls">
        <div className="control-head">
          <div><span>排版控制</span><h3>改任何一项都会升一个修订号</h3></div>
        </div>

        <div className="font-row">
          <label className={p.conflicts.some((c) => c.field === 'headingFont') ? 'field-conflict' : ''}>
            标题字体{p.conflicts.some((c) => c.field === 'headingFont') && <em className="conflict-tag">冲突中</em>}
            <select value={p.headingFont} onChange={(e) => props.onEdit('headingFont', e.target.value)}>
              {FONTS.map((f) => <option key={f}>{f}</option>)}
            </select>
          </label>
          <label className={p.conflicts.some((c) => c.field === 'bodyFont') ? 'field-conflict' : ''}>
            正文字体{p.conflicts.some((c) => c.field === 'bodyFont') && <em className="conflict-tag">冲突中</em>}
            <select value={p.bodyFont} onChange={(e) => props.onEdit('bodyFont', e.target.value)}>
              {FONTS.map((f) => <option key={f}>{f}</option>)}
            </select>
          </label>
        </div>

        <RangeRow label="字号" field="size" unit="px" min={28} max={76} step={1} value={p.size} conflict={p.conflicts.some((c) => c.field === 'size')} onEdit={props.onEdit}/>
        <RangeRow label="字重" field="weight" unit="" min={300} max={800} step={100} value={p.weight} conflict={p.conflicts.some((c) => c.field === 'weight')} onEdit={props.onEdit}/>
        <RangeRow label="行高" field="leading" unit="" min={1} max={1.8} step={0.05} fixed={2} value={p.leading} conflict={p.conflicts.some((c) => c.field === 'leading')} onEdit={props.onEdit}/>
        <RangeRow label="字距" field="tracking" unit="px" min={-1} max={3} step={0.5} value={p.tracking} conflict={p.conflicts.some((c) => c.field === 'tracking')} onEdit={props.onEdit}/>

        <div className="text-row">
          <label>分类
            <input value={p.category} onChange={(e) => props.onEdit('category', e.target.value)}/>
          </label>
          <label>所属合集（只能选一个）
            <select value={p.collectionId ?? ''} onChange={(e) => props.onMove(e.target.value || null)}>
              <option value="">未归入合集</option>
              {props.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>
        <div className="text-row">
          <label>标题文案
            <textarea rows={2} value={p.heading} onChange={(e) => props.onEdit('heading', e.target.value)}/>
          </label>
          <label>正文文案
            <textarea rows={2} value={p.body} onChange={(e) => props.onEdit('body', e.target.value)}/>
          </label>
        </div>
      </div>

      <div className="studio-foot">
        <button className="delete" onClick={props.onDelete}><Trash2 size={15}/>删除配对</button>
        <div className="foot-right">
          <button className="save" onClick={props.onExportCss}><Download size={14}/>导出 CSS（含待确认/冲突来源）</button>
        </div>
      </div>
    </section>
  );
}

function RangeRow({label, field, unit, min, max, step, value, fixed, conflict, onEdit}: {
  label: string;
  field: FieldKey;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  fixed?: number;
  conflict: boolean;
  onEdit: (f: FieldKey, v: number) => void;
}): React.ReactElement {
  return (
    <div className={`range-row ${conflict ? 'field-conflict' : ''}`}>
      <label>
        {label}
        {conflict && <em className="conflict-tag">冲突中</em>}
        <b>{fixed !== undefined ? value.toFixed(fixed) : value}{unit}</b>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onEdit(field, Number(e.target.value))}/>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------

function ModalShell({title, children, onClose, wide}: {title: string; children: React.ReactNode; onClose: () => void; wide?: boolean}): React.ReactElement {
  return (
    <div className="backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="modal-x" onClick={onClose}><X size={17}/></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AddPairModal({collections, onClose, onCreate}: {
  collections: Workspace['collections'];
  onClose: () => void;
  onCreate: (title: string, category: string, collectionId: string | null) => void;
}): React.ReactElement {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Untitled');
  const [collectionId, setCollectionId] = useState<string>('');
  return (
    <ModalShell title="新建配对" onClose={onClose}>
      <label className="modal-label">配对名称
        <input autoFocus value={title} placeholder="例如：安静而确定" onChange={(e) => setTitle(e.target.value)}/>
      </label>
      <label className="modal-label">分类
        <input value={category} onChange={(e) => setCategory(e.target.value)}/>
      </label>
      <label className="modal-label">归入合集（一个配对只能属于一个合集）
        <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
          <option value="">暂不归入</option>
          {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <div className="modal-actions">
        <button className="outline" onClick={onClose}>取消</button>
        <button className="primary" disabled={!title.trim()} onClick={() => onCreate(title.trim(), category.trim() || 'Untitled', collectionId || null)}>创建</button>
      </div>
    </ModalShell>
  );
}

function MergeModal({onClose, onImport, fileRef}: {
  onClose: () => void;
  onImport: (text: string, simulateFailure: boolean) => ReturnType<ReturnType<typeof useWorkspace>['importBundleText']>;
  fileRef: React.RefObject<HTMLInputElement | null>;
}): React.ReactElement {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [simulate, setSimulate] = useState(false);
  const [report, setReport] = useState<ReturnType<typeof useWorkspace>['lastMerge']>(null);

  const doImport = (): void => {
    setError('');
    try {
      const summary = onImport(text, simulate);
      setReport(summary);
      if (!simulate) setText('');
    } catch (err) {
      setError((err as Error).message === 'commit-failed' ? '提交失败（模拟）：已自动回滚，正式数据未动。去掉“模拟失败”勾选后可立即重试。' : (err as Error).message);
    }
  };

  return (
    <ModalShell title="导入同事的离线改动包" onClose={onClose} wide>
      {!report ? (
        <>
          <p className="modal-hint">选择改动包文件，或把 JSON 内容粘贴到下面。合并在本地按字段做三方计算，全部成功才一次性写入；失败自动回滚，重试不会留下半批数据。</p>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{display: 'none'}}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              f.text().then((t) => setText(t));
            }}
          />
          <button className="outline filepick" onClick={() => fileRef.current?.click()}>
            <FileUp size={14}/>选择 .json 改动包
          </button>
          <textarea
            className="bundle-input"
            rows={7}
            placeholder='{"format":"type-pairer-bundle", …}'
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <label className="simulate">
            <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)}/>
            模拟提交阶段写入失败（验证失败回滚、重试不留半批）
          </label>
          {error && <div className="modal-error"><AlertTriangle size={14}/>{error}</div>}
          <div className="modal-actions">
            <button className="outline" onClick={onClose}>关闭</button>
            <button className="primary" disabled={!text.trim()} onClick={doImport}>
              <RefreshCw size={14}/>{simulate ? '先试一次失败提交' : '执行合并'}
            </button>
          </div>
        </>
      ) : (
        <MergeReport report={report} onClose={onClose}/>
      )}
    </ModalShell>
  );
}

function MergeReport({report, onClose}: {report: NonNullable<ReturnType<typeof useWorkspace>['lastMerge']>; onClose: () => void}): React.ReactElement {
  return (
    <>
      <div className="report-summary">
        <div><b>{report.newPairCount}</b><span>新增配对</span></div>
        <div><b>{report.acceptedCount}</b><span>自动并入字段</span></div>
        <div className={report.conflictCount ? 'bad' : ''}><b>{report.conflictCount}</b><span>冲突字段（两版保留）</span></div>
      </div>
      <div className="report-list">
        {report.reports.filter((r) => r.status !== 'unchanged' || r.changes.length > 0).map((r) => (
          <div key={r.pairId} className={`report-row ${r.status}`}>
            <div className="report-row-head">
              <b>{r.title}</b>
              <span className={`mini-badge ${r.status}`}>
                {r.status === 'new' ? '新增' : r.status === 'conflicted' ? `冲突 ${r.changes.filter((c) => c.kind.startsWith('conflict')).length}` : r.status === 'updated' ? '已更新' : '无变化'}
              </span>
            </div>
            <ul>
              {r.changes.map((c, i) => (
                <li key={i} className={c.kind}>
                  {FIELD_LABELS[c.field]}：
                  {c.kind === 'accepted-incoming' && '自动并入对端版'}
                  {c.kind === 'accepted-local' && '保留本机版'}
                  {c.kind === 'identical' && '两边改后一致'}
                  {c.kind.startsWith('conflict') && '两边都改了，两版均已保留并标冲突'}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="primary" onClick={onClose}>完成，去解决冲突</button>
      </div>
    </>
  );
}

function LogModal({ws, onClose}: {ws: Workspace; onClose: () => void}): React.ReactElement {
  return (
    <ModalShell title="合并 / 回滚 / 迁移记录" onClose={onClose} wide>
      <div className="log-list">
        {ws.logs.map((l, i) => (
          <div key={i} className={`log-row ${l.kind}`}>
            <span className="log-kind">{l.kind}</span>
            <span className="log-time">{new Date(l.at).toLocaleString('zh-CN')}</span>
            <span className="log-text">{l.text}</span>
          </div>
        ))}
      </div>
      <div className="processed-list">
        已并入改动包：{ws.processedBundles.length === 0 ? '无' : ws.processedBundles.map((b) => b.slice(-6)).join('、')}
        （重复导入会被直接拒绝）
      </div>
      <div className="modal-actions"><button className="outline" onClick={onClose}>关闭</button></div>
    </ModalShell>
  );
}
