// React 状态层：把纯逻辑核心接到 localStorage，所有写入都走原子提交。
// 注意：提交是副作用，不能放在 setState 的 updater 里（StrictMode 会双调用）。
// 这里用 wsRef 持有最新工作区，先在事件处理中计算+提交，提交成功才 setState。

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  addLog,
  bumpPair,
  clone,
  confirmPublish,
  type ConflictChoice,
  FIELD_LABELS,
  newId,
  planMerge,
  resolveConflict,
  toggleFavorite,
} from './engine';
import type {
  Bundle,
  Collection,
  FieldKey,
  LogEntry,
  Pair,
  Workspace,
} from './types';
import {
  commitWorkspace,
  exportBundle,
  exportCss,
  type KVStore,
  loadWorkspace,
  parseBundle,
  serializeBundle,
  STORAGE_KEY,
} from './persistence';

export interface MergeSummary {
  reports: import('./engine').PairReport[];
  bundleId: string;
  fromEditor: string;
  conflictCount: number;
  acceptedCount: number;
  newPairCount: number;
}

export interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'warn';
  text: string;
}

export interface WorkspaceApi {
  ws: Workspace;
  ready: boolean;
  toast: Toast | null;
  lastMerge: MergeSummary | null;
  recoveredStage: boolean;
  updateField: (pairId: string, field: FieldKey, value: unknown) => void;
  setFavorite: (pairId: string, favorite: boolean) => void;
  moveToCollection: (pairId: string, collectionId: string | null) => void;
  publish: (pairId: string) => void;
  resolve: (pairId: string, field: FieldKey, choice: ConflictChoice) => void;
  createPair: (input: {title: string; category: string; collectionId: string | null}) => string;
  deletePair: (pairId: string) => void;
  createCollection: (name: string) => string;
  renameCollection: (id: string, name: string) => void;
  exportBundleFile: () => string;
  importBundleText: (text: string, opts?: {simulateCommitFailure?: boolean}) => MergeSummary;
  downloadCss: (pairId: string) => void;
  dismissToast: () => void;
  clearRecoveryFlag: () => void;
}

function browserStore(): KVStore {
  return {
    getItem: (k) => window.localStorage.getItem(k),
    setItem: (k, v) => window.localStorage.setItem(k, v),
    removeItem: (k) => window.localStorage.removeItem(k),
  };
}

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function useWorkspace(): WorkspaceApi {
  const storeRef = useRef<KVStore | null>(null);
  const wsRef = useRef<Workspace | null>(null);
  const [ready, setReady] = useState(false);
  const [ws, setWsState] = useState<Workspace | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [lastMerge, setLastMerge] = useState<MergeSummary | null>(null);
  const [recoveredStage, setRecoveredStage] = useState(false);
  const toastSeq = useRef(0);

  const setWs = useCallback((next: Workspace) => {
    wsRef.current = next;
    setWsState(next);
  }, []);

  const notify = useCallback((kind: Toast['kind'], text: string) => {
    toastSeq.current += 1;
    setToast({id: toastSeq.current, kind, text});
  }, []);

  // 唯一写入口：基于最新工作区计算 → 原子提交 → 成功后才更新内存状态。
  // 提交失败：内存状态与正式键都保持原值，绝不留半批，调用方可立即重试。
  const mutate = useCallback(
    (produce: (draft: Workspace) => Workspace, opts: {failAtCommit?: boolean} = {}): Workspace | null => {
      const current = wsRef.current;
      if (!current) return null;
      const next = produce(clone(current));
      try {
        commitWorkspace(storeRef.current!, next, {failAtCommit: opts.failAtCommit});
      } catch (err) {
        notify('error', `保存失败，已回滚到合并前状态，没有写入半批数据，可直接重试。（${(err as Error).message}）`);
        return null;
      }
      setWs(next);
      return next;
    },
    [notify, setWs],
  );

  useEffect(() => {
    const store = browserStore();
    storeRef.current = store;
    const loaded = loadWorkspace(store, Date.now());
    wsRef.current = loaded.workspace;
    setWsState(loaded.workspace);
    setRecoveredStage(loaded.recoveredStage);
    if (loaded.recoveredStage) {
      setToast({
        id: ++toastSeq.current,
        kind: 'warn',
        text: '检测到上次失败的合并暂存，已丢弃；正式数据完好，可重新导入合并。',
      });
    }
    setReady(true);
  }, []);

  const updateField = useCallback(
    (pairId: string, field: FieldKey, value: unknown) => {
      mutate((draft) => {
        const p = draft.pairs.find((x) => x.id === pairId);
        if (!p) return draft;
        const next = bumpPair(p, field, value as Pair[FieldKey], draft.editorName, Date.now());
        if (next === p) return draft;
        draft.pairs = draft.pairs.map((x) => (x.id === pairId ? next : x));
        return draft;
      });
    },
    [mutate],
  );

  const setFavorite = useCallback(
    (pairId: string, favorite: boolean) => {
      mutate((draft) => {
        draft.pairs = draft.pairs.map((p) =>
          p.id === pairId ? {...toggleFavorite(p), favorite} : p,
        );
        return draft;
      });
    },
    [mutate],
  );

  const moveToCollection = useCallback(
    (pairId: string, collectionId: string | null) => {
      mutate((draft) => {
        const p = draft.pairs.find((x) => x.id === pairId);
        if (!p || p.collectionId === collectionId) return draft;
        const next = bumpPair(p, 'collectionId', collectionId, draft.editorName, Date.now());
        draft.pairs = draft.pairs.map((x) => (x.id === pairId ? next : x));
        return draft;
      });
    },
    [mutate],
  );

  const publish = useCallback(
    (pairId: string) => {
      const now = Date.now();
      const ok = mutate((draft) => {
        const p = draft.pairs.find((x) => x.id === pairId);
        if (!p) return draft;
        const next = confirmPublish(p, now);
        draft.pairs = draft.pairs.map((x) => (x.id === pairId ? next : x));
        return addLog(draft, 'publish', `「${p.title}」已重新确认发布（r${next.revision}）`, now);
      });
      if (ok) notify('ok', '已确认发布，页面与导出的待确认标记已清除');
    },
    [mutate, notify],
  );

  const resolve = useCallback(
    (pairId: string, field: FieldKey, choice: ConflictChoice) => {
      const now = Date.now();
      const ok = mutate((draft) => {
        const p = draft.pairs.find((x) => x.id === pairId);
        if (!p) return draft;
        const next = resolveConflict(p, field, choice, draft.editorName, now);
        if (next === p) return draft;
        draft.pairs = draft.pairs.map((x) => (x.id === pairId ? next : x));
        // 只把“已解决的这个字段”推进到新基线；其他仍在冲突的字段保持旧基线，
        // 这样它们在下一次三方合并里仍然算得清。
        const basePair = draft.base[pairId];
        if (basePair) {
          const resolvedField = field;
          (basePair as Record<FieldKey, unknown>)[resolvedField] = clone(
            (next as Record<FieldKey, unknown>)[resolvedField],
          );
          basePair.conflicts = [];
        }
        return draft;
      });
      if (ok) notify('ok', `已采用所选版本解决「${FIELD_LABELS[field]}」冲突`);
    },
    [mutate, notify],
  );

  const createPair = useCallback(
    (input: {title: string; category: string; collectionId: string | null}): string => {
      const id = newId('p');
      const now = Date.now();
      mutate((draft) => {
        const stamp = {author: draft.editorName, at: now};
        const pair: Pair = {
          id,
          title: input.title,
          category: input.category || 'Untitled',
          heading: 'Your new headline',
          body: 'Start with a sentence that lets your type pairing show its character.',
          headingFont: 'Fraunces',
          bodyFont: 'DM Sans',
          size: 46,
          weight: 600,
          leading: 1.25,
          tracking: 0,
          favorite: false,
          // 配对只能属于一个合集。
          collectionId: input.collectionId,
          revision: 1,
          updatedAt: now,
          updatedBy: draft.editorName,
          sources: {
            headingFont: stamp,
            bodyFont: stamp,
            size: stamp,
            weight: stamp,
            leading: stamp,
            tracking: stamp,
          },
          published: null,
          conflicts: [],
        };
        draft.pairs = [...draft.pairs, pair];
        draft.base[id] = clone(pair);
        return draft;
      });
      return id;
    },
    [mutate],
  );

  const deletePair = useCallback(
    (pairId: string) => {
      mutate((draft) => {
        draft.pairs = draft.pairs.filter((p) => p.id !== pairId);
        return draft;
      });
    },
    [mutate],
  );

  const createCollection = useCallback(
    (name: string): string => {
      const id = newId('col');
      mutate((draft) => {
        draft.collections = [...draft.collections, {id, name, color: '#cbb9d8'}];
        return draft;
      });
      return id;
    },
    [mutate],
  );

  const renameCollection = useCallback(
    (id: string, name: string) => {
      mutate((draft) => {
        draft.collections = draft.collections.map((c) => (c.id === id ? {...c, name} : c));
        return draft;
      });
    },
    [mutate],
  );

  const exportBundleFile = useCallback((): string => {
    const current = wsRef.current;
    if (!current) return '';
    const now = Date.now();
    const bundle = exportBundle(current, now);
    download(
      `type-pairer-bundle-${bundle.bundleId.slice(-6)}.json`,
      serializeBundle(bundle),
      'application/json',
    );
    mutate((draft) =>
      addLog(draft, 'export', `导出离线改动包 ${bundle.bundleId.slice(-6)}（${draft.pairs.length} 条配对）`, Date.now()),
    );
    notify('ok', '离线改动包已导出，可发给同事；三方合并基线已打包在内');
    return bundle.bundleId;
  }, [mutate, notify]);

  const importBundleText = useCallback(
    (text: string, opts: {simulateCommitFailure?: boolean} = {}): MergeSummary => {
      const current = wsRef.current;
      if (!current) throw new Error('工作区尚未就绪');
      let bundle: Bundle;
      try {
        bundle = parseBundle(text);
      } catch (err) {
        notify('error', `改动包无法读取：${(err as Error).message}`);
        throw err;
      }
      const plan = planMerge(current, bundle, Date.now());
      if (!plan.ok) {
        notify('error', plan.error);
        throw new Error(plan.error);
      }
      const committed = mutate(
        () =>
          addLog(
            plan.workspace,
            'import',
            `并入 ${bundle.editorName} 的改动包 ${bundle.bundleId.slice(-6)}：新增 ${plan.newPairCount}、自动并入 ${plan.acceptedCount} 个字段、冲突 ${plan.conflictCount} 项`,
            Date.now(),
          ),
        {failAtCommit: opts.simulateCommitFailure},
      );
      if (!committed) {
        throw new Error('commit-failed');
      }
      const summary: MergeSummary = {
        reports: plan.reports,
        bundleId: plan.bundleId,
        fromEditor: plan.fromEditor,
        conflictCount: plan.conflictCount,
        acceptedCount: plan.acceptedCount,
        newPairCount: plan.newPairCount,
      };
      setLastMerge(summary);
      notify(
        plan.conflictCount > 0 ? 'warn' : 'ok',
        `合并已原子提交：新增 ${plan.newPairCount} 条，自动并入 ${plan.acceptedCount} 个字段，` +
          (plan.conflictCount > 0
            ? `${plan.conflictCount} 个字段两边都改了，两版均已保留并标出来源，请逐条解决`
            : '无冲突'),
      );
      return summary;
    },
    [mutate, notify],
  );

  const downloadCss = useCallback(
    (pairId: string) => {
      const current = wsRef.current;
      if (!current) return;
      const pair = current.pairs.find((p) => p.id === pairId);
      if (!pair) return;
      const css = exportCss(pair, current.collections);
      download(`pair-r${pair.revision}.css`, css, 'text/css');
      mutate((draft) =>
        addLog(
          draft,
          'export',
          `导出「${pair.title}」CSS（r${pair.revision}${pair.conflicts.length ? `，含 ${pair.conflicts.length} 项冲突` : ''}）`,
          Date.now(),
        ),
      );
    },
    [mutate],
  );

  const dismissToast = useCallback(() => setToast(null), []);
  const clearRecoveryFlag = useCallback(() => setRecoveredStage(false), []);

  const placeholder = useMemo<WorkspaceApi>(
    () => ({
      ws: ws as Workspace,
      ready: false,
      toast: null,
      lastMerge: null,
      recoveredStage: false,
      updateField: () => {},
      setFavorite: () => {},
      moveToCollection: () => {},
      publish: () => {},
      resolve: () => {},
      createPair: () => '',
      deletePair: () => {},
      createCollection: () => '',
      renameCollection: () => {},
      exportBundleFile: () => '',
      importBundleText: () => ({
        reports: [], bundleId: '', fromEditor: '', conflictCount: 0, acceptedCount: 0, newPairCount: 0,
      }),
      downloadCss: () => {},
      dismissToast: () => {},
      clearRecoveryFlag: () => {},
    }),
    [ws],
  );

  const api = useMemo<WorkspaceApi | null>(() => {
    if (!ws) return null;
    return {
      ws,
      ready,
      toast,
      lastMerge,
      recoveredStage,
      updateField,
      setFavorite,
      moveToCollection,
      publish,
      resolve,
      createPair,
      deletePair,
      createCollection,
      renameCollection,
      exportBundleFile,
      importBundleText,
      downloadCss,
      dismissToast,
      clearRecoveryFlag,
    };
  }, [
    ws, ready, toast, lastMerge, recoveredStage, updateField, setFavorite,
    moveToCollection, publish, resolve, createPair, deletePair, createCollection,
    renameCollection, exportBundleFile, importBundleText, downloadCss,
    dismissToast, clearRecoveryFlag,
  ]);

  return api ?? placeholder;
}

export const STORAGE_NAME = STORAGE_KEY;
export type {Collection, LogEntry};
