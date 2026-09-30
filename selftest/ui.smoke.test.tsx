// @vitest-environment jsdom
// 真实 DOM 冒烟：渲染整个应用，验证待确认提示、改字体失效、localStorage 落盘与冲突 UI。
import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import React from 'react';
import App from '../src/App';
import {clone} from '../src/core/engine';
import {exportBundle, loadWorkspace} from '../src/core/persistence';

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  document.body.innerHTML = '';
});

function renderApp(): void {
  act(() => {
    createRoot(document.getElementById('root')!).render(React.createElement(App));
  });
}

function clickButton(text: string): void {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(text),
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`找不到按钮：${text}`);
  act(() => btn.dispatchEvent(new MouseEvent('click', {bubbles: true})));
}

async function clickButtonAsync(text: string): Promise<void> {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(text),
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`找不到按钮：${text}`);
  await act(async () => btn.dispatchEvent(new MouseEvent('click', {bubbles: true})));
}

async function fillTextarea(selector: string, value: string): Promise<void> {
  const el = document.querySelector(selector) as HTMLTextAreaElement;
  if (!el) throw new Error(`找不到输入框：${selector}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', {bubbles: true}));
  });
}

describe('Type Pairer 合并台 UI', () => {
  it('首屏渲染：离线合并台入口、待确认数量、初始旧发布失效提示都在', () => {
    renderApp();
    const text = document.body.textContent ?? '';
    expect(text).toContain('离线合并台');
    expect(text).toContain('导出我的改动包');
    expect(text).toContain('导入同事改动包');
    // p1 种子预置了 stale（当前字体 Fraunces，旧发布是 Newsreader）
    expect(text).toContain('待重新确认');
    expect(text).toContain('待确认发布');
  });

  it('切换标题字体后旧发布立刻标 stale，修订号 +1 并落盘 localStorage', () => {
    renderApp();
    const readP1 = () =>
      (JSON.parse(localStorage.getItem('type-pairer-workspace-v2')!) as {
        pairs: Array<{id: string; headingFont: string; revision: number; published: {headingFont: string} | null}>;
      }).pairs.find((p) => p.id === 'p1')!;
    const before = readP1();
    expect(before.published?.headingFont).toBe('Newsreader');
    const revBefore = before.revision;

    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[];
    const headingSelect = selects[0];
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(headingSelect, 'Playfair Display');
      headingSelect.dispatchEvent(new Event('change', {bubbles: true}));
    });

    const after = readP1();
    expect(after.headingFont).toBe('Playfair Display');
    expect(after.revision).toBe(revBefore + 1);
    // 旧发布快照保留，用于显示“已失效”
    expect(after.published?.headingFont).toBe('Newsreader');
    expect(document.body.textContent).toContain('待重新确认');
  });

  it('每个配对都带修订号，collectionId 只能是单值（单合集归属）', () => {
    renderApp();
    const stored = JSON.parse(localStorage.getItem('type-pairer-workspace-v2')!) as {
      pairs: Array<{revision: number; collectionId: string | null}>;
    };
    for (const p of stored.pairs) {
      expect(typeof p.revision).toBe('number');
      expect(p.revision).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(p.collectionId)).toBe(false);
      expect(p.collectionId === null || typeof p.collectionId === 'string').toBe(true);
    }
  });

  it('导入两边同改字号的包：报告提示冲突，面板显示两版与双方来源；重复导入被拒', async () => {
    // 对端工作区：把 p1 字号改成 70
    const loaded = loadWorkspace(localStorage, Date.now());
    const other = clone(loaded.workspace);
    other.editorId = 'coworker';
    other.editorName = '同事阿岚';
    const op = other.pairs.find((p) => p.id === 'p1')!;
    op.size = 70;
    op.revision += 1;
    op.updatedBy = '同事阿岚';
    op.sources.size = {author: '同事阿岚', at: Date.now()};
    const bundle = exportBundle(other, Date.now());

    // 本机工作区：把 p1 字号改成 30
    const local = clone(loaded.workspace);
    const lp = local.pairs.find((p) => p.id === 'p1')!;
    lp.size = 30;
    lp.revision += 1;
    lp.sources.size = {author: local.editorName, at: Date.now()};
    localStorage.setItem('type-pairer-workspace-v2', JSON.stringify(local));

    renderApp();
    expect(document.body.textContent).not.toContain('待解决冲突 1 项');

    clickButton('导入同事改动包');
    await fillTextarea('textarea.bundle-input', JSON.stringify(bundle));
    await clickButtonAsync('执行合并');

    // 合并报告
    expect(document.body.textContent).toContain('两版均已保留');
    await clickButtonAsync('完成，去解决冲突');

    // 冲突面板：双方来源 + 两版 + 操作按钮
    const panel = document.body.textContent ?? '';
    expect(panel).toContain('待解决冲突 1 项');
    expect(panel).toContain('同事阿岚');
    expect(panel).toContain('采用本机版');
    expect(panel).toContain('采用对端版');
    expect(panel).toContain('字号冲突');

    // 同一包再导一次：被拒绝
    clickButton('导入同事改动包');
    await fillTextarea('textarea.bundle-input', JSON.stringify(bundle));
    await clickButtonAsync('执行合并');
    expect(document.body.textContent).toContain('已经并入过');

    // 落盘数据里冲突两版都在
    const stored = JSON.parse(localStorage.getItem('type-pairer-workspace-v2')!) as {
      pairs: Array<{id: string; size: number; conflicts: Array<{field: string; localValue: number; incomingValue: number}>}>;
    };
    const p1 = stored.pairs.find((p) => p.id === 'p1')!;
    expect(p1.size).toBe(30); // 工作值暂取本机
    expect(p1.conflicts).toHaveLength(1);
    expect(p1.conflicts[0].field).toBe('size');
    expect(p1.conflicts[0].localValue).toBe(30);
    expect(p1.conflicts[0].incomingValue).toBe(70);
  });

  it('模拟提交失败：正式数据不被污染，去掉模拟后重试成功', async () => {
    const loaded = loadWorkspace(localStorage, Date.now());
    const other = clone(loaded.workspace);
    other.editorId = 'coworker2';
    other.editorName = '同事小川';
    const op = other.pairs.find((p) => p.id === 'p2')!;
    op.tracking = 2.5;
    op.revision += 1;
    op.sources.tracking = {author: '同事小川', at: Date.now()};
    const bundle = exportBundle(other, Date.now());

    renderApp();
    const snapshot = localStorage.getItem('type-pairer-workspace-v2')!;

    clickButton('导入同事改动包');
    await fillTextarea('textarea.bundle-input', JSON.stringify(bundle));
    const box = document.querySelector('.simulate input') as HTMLInputElement;
    await act(async () => box.click());
    // 勾选后按钮文案切换
    expect(document.body.textContent).toContain('先试一次失败提交');
    await clickButtonAsync('先试一次失败提交');

    expect(document.body.textContent).toContain('已自动回滚');
    // 正式键未变、暂存被清理
    expect(localStorage.getItem('type-pairer-workspace-v2')).toBe(snapshot);
    expect(localStorage.getItem('type-pairer-stage-v2')).toBeNull();

    // 关掉弹窗重来（同一包尚未被并入，可正常重试）
    await clickButtonAsync('关闭');
    clickButton('导入同事改动包');
    await fillTextarea('textarea.bundle-input', JSON.stringify(bundle));
    await clickButtonAsync('执行合并');
    expect(document.body.textContent).toContain('合并已原子提交');
    const stored = JSON.parse(localStorage.getItem('type-pairer-workspace-v2')!) as {
      pairs: Array<{id: string; tracking: number}>;
    };
    expect(stored.pairs.find((p) => p.id === 'p2')!.tracking).toBe(2.5);
  });

  it('旧版数据（type-pairs，无修订号）首次打开自动升级：补号、收藏/合集保留、需重新确认', () => {
    localStorage.setItem(
      'type-pairs',
      JSON.stringify([
        {id: 1, title: '旧版珍藏', heading: '老标题', body: '老正文', category: 'Poster', favorite: true},
        {id: 2, title: '普通旧稿', heading: 'H', body: 'B', category: 'Editorial', favorite: false},
      ]),
    );
    renderApp();

    const text = document.body.textContent ?? '';
    expect(text).toContain('旧版珍藏');
    expect(text).toContain('Poster');
    // 合集侧栏为旧分类补建了同名合集
    expect(text).toContain('Poster');
    // 待确认：迁移后的旧数据没有发布快照
    expect(text).toContain('待确认');

    const stored = JSON.parse(localStorage.getItem('type-pairer-workspace-v2')!) as {
      pairs: Array<{
        id: string;
        title: string;
        favorite: boolean;
        revision: number;
        published: null;
        collectionId: string | null;
      }>;
      collections: Array<{name: string}>;
    };
    expect(stored.pairs).toHaveLength(2);
    const treasured = stored.pairs.find((p) => p.title === '旧版珍藏')!;
    expect(treasured.revision).toBe(1); // 缺修订号 => 补 r1
    expect(treasured.favorite).toBe(true); // 收藏没丢
    expect(treasured.published).toBeNull(); // 需重新确认
    expect(treasured.collectionId).toBeTruthy(); // 归入（补建的）合集
    const col = stored.collections.find((c) => c.name === 'Poster');
    expect(col).toBeTruthy();
    expect(treasured.collectionId).toBe(col!.id);
    // 原有合集也还在
    expect(stored.collections.some((c) => c.name === 'Editorial')).toBe(true);
    // 新键已写，下次启动不重复迁移
    expect(localStorage.getItem('type-pairs')).toBeTruthy();
  });
});
