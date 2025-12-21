# Enhancement: Add OID Path Breadcrumb Navigation

**Label:** `enhancement`

---

## 概要

ノード詳細パネルに、ルートから現在のノードまでのOIDパスをクリック可能なBreadcrumbとして表示する。

## 背景

現在、ノードの詳細を見ている時に:
- そのノードがツリー内のどこに位置しているか分かりにくい
- 親ノードへ移動するには、ツリーを手動で探す必要がある
- OIDの階層構造が視覚的に分かりにくい

## 提案

### UI例

NodeDetailsコンポーネントの上部に表示:

```
iso > org > dod > internet > mgmt > mib-2 > system > sysDescr
```

各セグメントはクリック可能で、クリックすると該当ノードに移動します。

### 詳細な表示例

**簡潔版（デフォルト）:**
```
Home > iso > org > dod > internet > mgmt > mib-2 > system > sysDescr
```

**詳細版（オプション）:**
```
Home > iso(1) > org(3) > dod(6) > internet(1) > mgmt(2) > mib-2(1) > system(1) > sysDescr(1)
```

**モバイル対応:**
長いパスの場合、途中を省略:
```
Home > ... > mib-2 > system > sysDescr
```

### 実装の詳細

#### 必要な機能

1. **パス生成**
   - 既存の`getOidPath()`関数を活用
   - OIDからノードオブジェクトのリストを取得

2. **Breadcrumbコンポーネント**
```typescript
interface BreadcrumbItem {
  name: string;
  oid: string;
  node: MibNode;
}

interface OidBreadcrumbProps {
  node: MibNode;
  onNavigate: (node: MibNode) => void;
}
```

3. **スタイリング**
   - 矢印（>）または `/` で区切り
   - ホバー時に下線
   - 現在のノードは太字でクリック不可
   - Tailwind CSS: `text-sm text-gray-600`

4. **インタラクション**
   - クリックで該当ノードに移動
   - ツリーを自動的に展開してノードを表示
   - `onSelectNode`を呼び出す

#### 影響を受けるコンポーネント

1. **NodeDetails.tsx**
   - Breadcrumbコンポーネントを追加
   - レイアウト調整

2. **新規コンポーネント: OidBreadcrumb.tsx**
   - Breadcrumb表示ロジック
   - クリックハンドラ

3. **lib/oid-utils.ts**（既存）
   - `getOidPath()`関数を活用
   - 必要に応じて拡張

## メリット

- ノードの位置が一目で分かる
- 親ノードへの移動が簡単になる
- MIB階層の理解が深まる
- ナビゲーション体験が大幅に向上

## UI/UXの参考

- ファイルエクスプローラーのパスバー
- Webサイトのパンくずリスト
- VSCodeのファイルパス表示

## 難易度

**中** - 3-4時間程度で実装可能

実装の複雑さ:
- パス生成: 簡単（既存関数あり）
- UI実装: 中程度
- ナビゲーション連携: 中程度

## 関連issue

- #0 Feature Improvement Roadmap
- #6 Navigation History（実装後、Breadcrumbと履歴の連携が可能）
