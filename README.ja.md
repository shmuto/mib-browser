# SNMP MIB Browser

[English](./README.md) | **日本語**

SNMP MIB ファイルをブラウザ上で閲覧・解析できるクライアントサイド Web アプリケーションです。

複数の MIB ファイルを読み込むだけで、統合された単一の OID ツリーとして確認できます。すべての処理はブラウザ内で完結するため、サーバーへのアップロードやアカウント登録は不要です。

🔗 **ライブデモ:** [https://shmuto.github.io/mib-browser/](https://shmuto.github.io/mib-browser/)

---

## 主な機能

- **フォルダ・複数ファイルの一括読み込み:** ディレクトリをドラッグ＆ドロップまたは選択するだけで、サブディレクトリ内の MIB ファイルも読み込み順を問わず再帰的に取り込めます。
- **統合 OID ツリー:** モジュール間の `IMPORTS` を解決し、SMIv1 の `TRAP-TYPE` 定義も含めて単一の OID 階層に統合します。
- **検索・フィルタリング:** オブジェクト名・OID・説明文での検索、**Traps only**（`NOTIFICATION-TYPE` / `TRAP-TYPE` のみ表示）、単一子ノードの連鎖を折りたたむ **Compact view** に対応しています。
- **ノード詳細表示:** OID、`MODULE::object` 表記、構文（`SYNTAX`）、列挙値（`INTEGER` / `TEXTUAL-CONVENTION`）、通知の varbind、説明文、参照元ファイルを確認できます。
- **診断機能:** 未読み込みの `IMPORTS` 依存関係、配置できない定義、同一モジュール定義の競合（フィールド単位の差分表示）を検出して報告します。
- **大規模コレクション対応:** 仮想スクロールによるツリー描画で、数万ノード規模の MIB でも軽快に動作します。

**対応する SMI 構文:** `MODULE-IDENTITY`、`OBJECT-IDENTITY`、`OBJECT IDENTIFIER`、`OBJECT-TYPE`、`TEXTUAL-CONVENTION`、`NOTIFICATION-TYPE`、`TRAP-TYPE`、`OBJECT-GROUP`、`NOTIFICATION-GROUP`、`MODULE-COMPLIANCE`、複数サブ識別子の指定、ルートアーク起点の定義（IEEE 802.1 など）。

---

## 開発

```bash
bun install
bun run dev        # 開発サーバーを起動
bun test           # ユニットテストを実行
bun run typecheck  # tsc --noEmit で型チェック
bun run build      # 型チェック後、dist/ へ本番ビルド
```

> [!TIP]
> 保存データの破損などでアプリが起動できなくなった場合は、URL に **`?reset=true`** を付けて開くと IndexedDB を初期化できます。

---

## ドキュメント（英語）

| ドキュメント | 内容 |
|---|---|
| [docs/ARCHITECTURE_EN.md](./docs/ARCHITECTURE_EN.md) | モジュール構成、データフロー、状態管理、描画、永続化 |
| [docs/MIB_TREE_CONSTRUCTION_EN.md](./docs/MIB_TREE_CONSTRUCTION_EN.md) | MIB パース処理、3 パスツリー構築、競合検出の詳細 |
| [docs/PERFORMANCE_EN.md](./docs/PERFORMANCE_EN.md) | ベンチマーク、最適化内容、設計上の不変条件、計測方法 |
| [docs/INCREMENTAL_UPDATE_PROPOSAL_EN.md](./docs/INCREMENTAL_UPDATE_PROPOSAL_EN.md) | 差分ツリー更新の再評価と実装済み改善のまとめ |
| [test-data/README.md](./test-data/README.md) | テスト用フィクスチャと大規模コーパス生成スクリプト |

---

## ライセンス

MIT License
