// 合并台数据模型：所有结构都可 JSON 序列化，保证离线可续作。

export type FieldKey =
  | 'title'
  | 'category'
  | 'heading'
  | 'body'
  | 'headingFont'
  | 'bodyFont'
  | 'size'
  | 'weight'
  | 'leading'
  | 'tracking'
  | 'collectionId';

/** 某次修改的来源：谁、什么时候改的。冲突卡片和导出文件都靠它标注来源。 */
export interface Stamp {
  author: string;
  at: number;
}

/** 同一字段两边都改了：两版都保留，任一方解决前一直挂着。 */
export interface ConflictEntry {
  /** pairId::field，三方计算结果天然一致，便于多跳离线合并去重。 */
  id: string;
  field: FieldKey;
  base: unknown;
  localValue: unknown;
  incomingValue: unknown;
  localSource: Stamp;
  incomingSource: Stamp;
}

/** 最近一次确认发布的字体快照；标题/正文字体一旦对不上就作废。 */
export interface Published {
  revision: number;
  headingFont: string;
  bodyFont: string;
  at: number;
}

export interface Pair {
  id: string;
  title: string;
  category: string;
  heading: string;
  body: string;
  headingFont: string;
  bodyFont: string;
  size: number;
  weight: number;
  leading: number;
  tracking: number;
  favorite: boolean;
  /** 配对只能属于一个合集；null = 未归入任何合集。 */
  collectionId: string | null;
  revision: number;
  updatedAt: number;
  updatedBy: string;
  /** 每个字段最近一次修改的出处，冲突时作为“来源”展示。 */
  sources: Partial<Record<FieldKey, Stamp>>;
  published: Published | null;
  conflicts: ConflictEntry[];
}

export interface Collection {
  id: string;
  name: string;
  color: string;
}

export type LogKind = 'export' | 'import' | 'publish' | 'rollback' | 'migration';

export interface LogEntry {
  at: number;
  kind: LogKind;
  text: string;
}

export interface Workspace {
  version: 2;
  editorId: string;
  editorName: string;
  pairs: Pair[];
  collections: Collection[];
  /** 上次与对端同步时各字段的基线，三方合并的 base。 */
  base: Record<string, Pair>;
  logs: LogEntry[];
  /** 已并入的离线包 id，重复导入直接跳过。 */
  processedBundles: string[];
  lastImportedBundle: string | null;
}

/** 同事离线导出的改动包：base 是共同基线，current 是 ta 那边的现状。 */
export interface Bundle {
  format: 'type-pairer-bundle';
  bundleFormatVersion: 1;
  bundleId: string;
  basedOnBundleId: string | null;
  editorId: string;
  editorName: string;
  exportedAt: number;
  base: Record<string, Pair>;
  current: Record<string, Pair>;
  collections: Collection[];
}
