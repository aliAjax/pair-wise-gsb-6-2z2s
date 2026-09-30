// 冲突面板：每个同字段两版都保留，显示双方作者/时间/值，可二选一或给自定义值。
import type {ReactElement} from 'react';
import {AlertTriangle, Check, User} from 'lucide-react';
import {FIELD_LABELS} from '../core/engine';
import {formatValue} from '../core/persistence';
import type {Collection, ConflictEntry, FieldKey} from '../core/types';

function StampLine({who, when, align}: {who: string; when: number; align: 'left' | 'right'}): ReactElement {
  return (
    <div className={`stamp ${align}`}>
      <User size={11}/>
      <b>{who}</b>
      <span>
        {new Date(when).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})}
      </span>
    </div>
  );
}

export type ResolveChoice = {side: 'local' | 'incoming'} | {side: 'custom'; value: unknown};

export default function ConflictPanel(
  {conflicts, collections, onResolve}: {
    conflicts: ConflictEntry[];
    collections: Collection[];
    onResolve: (field: FieldKey, choice: ResolveChoice) => void;
  },
): ReactElement {
  const numeric = new Set(['tracking', 'size', 'weight', 'leading']);
  return (
    <div className="conflict-panel">
      <div className="conflict-head">
        <AlertTriangle size={15}/>
        <b>待解决冲突 {conflicts.length} 项</b>
        <span>两边离线都改了同一字段，两版均已保留并标来源；解决前工作值暂取本机版</span>
      </div>
      {conflicts.map((c) => (
        <div className="conflict-card" key={c.id}>
          <div className="conflict-field">{FIELD_LABELS[c.field]}冲突</div>
          <div className="conflict-cols">
            <div className="conflict-side local">
              <StampLine who={c.localSource.author} when={c.localSource.at} align="left"/>
              <code className="conflict-value">{formatValue(c.field, c.localValue, collections)}</code>
              <button onClick={() => onResolve(c.field, {side: 'local'})}>
                <Check size={13}/> 采用本机版
              </button>
            </div>
            <div className="vs">VS</div>
            <div className="conflict-side incoming">
              <StampLine who={c.incomingSource.author} when={c.incomingSource.at} align="right"/>
              <code className="conflict-value">{formatValue(c.field, c.incomingValue, collections)}</code>
              <button onClick={() => onResolve(c.field, {side: 'incoming'})}>
                <Check size={13}/> 采用对端版
              </button>
            </div>
          </div>
          {numeric.has(c.field) && (
            <div className="conflict-custom">
              <input
                type="number"
                step={c.field === 'leading' ? '0.05' : c.field === 'tracking' ? '0.5' : '1'}
                placeholder="或另给一版数值，回车确认…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = Number((e.target as HTMLInputElement).value);
                    if (!Number.isNaN(v)) onResolve(c.field, {side: 'custom', value: v});
                  }
                }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
