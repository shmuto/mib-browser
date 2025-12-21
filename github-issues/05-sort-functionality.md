# Enhancement: Add Sort Functionality for File List and Tree

**Label:** `enhancement`

---

## 概要

ファイルリストとMIBツリーにソート機能を追加し、ユーザーが情報を見つけやすくする。

## 背景

現在の実装では:
- ファイルリストの表示順序が固定（アップロード順？）
- ツリーノードの順序がソースファイルの定義順
- 大量のファイルやノードがある場合、目的のものを見つけにくい

## 提案

### 1. ファイルリストのソート（SavedMibsList）

#### ソート基準

- **名前** (A-Z / Z-A)
- **アップロード日時** (新しい順 / 古い順)
- **ファイルサイズ** (大きい順 / 小さい順)
- **MIB名** (A-Z / Z-A) ※実装後

#### UI

ファイルリストの上部にドロップダウン:

```
Saved MIBs
[Sort by: Name ▼]
```

または、列ヘッダーをクリックしてソート（テーブル形式の場合）:

```
Name ▲  |  Size  |  Date
```

#### 実装

```typescript
type SortField = 'name' | 'uploadedAt' | 'size' | 'mibName';
type SortOrder = 'asc' | 'desc';

const [sortField, setSortField] = useState<SortField>('uploadedAt');
const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

const sortedMibs = useMemo(() => {
  return [...mibs].sort((a, b) => {
    // ソートロジック
  });
}, [mibs, sortField, sortOrder]);
```

#### 永続化

- ソート設定をlocalStorageに保存
- 次回起動時に復元

### 2. ツリーノードのソート（MibTreeView）

#### ソート基準

- **名前** (A-Z / Z-A)
- **OID** (数値順)
- **ソースファイル順**（デフォルト、現在の動作）

#### UI

TreeExpandControlsコンポーネントに追加:

```
[Expand All] [Collapse All] [Compact ✓] [Sort: Name ▼]
```

#### 実装

```typescript
type TreeSortField = 'name' | 'oid' | 'source';

const sortTree = (nodes: MibNode[], field: TreeSortField): MibNode[] => {
  return nodes.map(node => ({
    ...node,
    children: sortTree(node.children, field).sort((a, b) => {
      if (field === 'name') {
        return a.name.localeCompare(b.name);
      } else if (field === 'oid') {
        return compareOids(a.oid, b.oid);
      }
      return 0; // source order
    })
  }));
};
```

#### OID比較関数

```typescript
const compareOids = (oidA: string, oidB: string): number => {
  const partsA = oidA.split('.').map(Number);
  const partsB = oidB.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const a = partsA[i] || 0;
    const b = partsB[i] || 0;
    if (a !== b) return a - b;
  }
  return 0;
};
```

### 3. 追加機能（オプション）

#### ソートアイコン

現在のソート状態を視覚的に表示:
- ▲ 昇順
- ▼ 降順

#### グループ化（将来的）

ファイルリストをMIB名やベンダーでグループ化

## メリット

### ファイルリストのソート
- 特定のファイルを素早く見つけられる
- 最近追加したファイルを確認しやすい
- 大きなファイルを特定できる

### ツリーのソート
- アルファベット順でノードを探しやすい
- OID順で体系的に確認できる
- 使用シーンに応じた表示が可能

## 難易度

**低** - 2-3時間程度で実装可能

実装の複雑さ:
- ファイルリストソート: 簡単
- ツリーソート: 中程度（再帰処理が必要）
- UI統合: 簡単

## 実装の優先順位

1. ファイルリストのソート（より需要が高い）
2. ツリーのソート

## 関連issue

- #0 Feature Improvement Roadmap
- #3 Search Improvements（検索結果のソートにも応用可能）
