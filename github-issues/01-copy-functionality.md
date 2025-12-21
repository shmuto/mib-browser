# Enhancement: Add Copy Functionality for OID and Node Details

**Label:** `enhancement`

---

## 概要

OIDや詳細情報をワンクリックでクリップボードにコピーできる機能を追加する。

## 背景

現在、ノードの詳細情報（OID、名前、説明など）を使用したい場合、手動でテキストを選択してコピーする必要があり、特にOIDのような長い文字列では不便です。

## 提案

### 実装箇所

`NodeDetails.tsx`に以下のコピーボタンを追加:

1. **OIDのコピー** - OID表示の横にコピーアイコン
2. **ノード名のコピー** - ノード名の横にコピーアイコン
3. **すべての詳細をコピー** - ヘッダー部分に「すべてコピー」ボタン

### UI例

```
OID: 1.3.6.1.2.1.1.1  [📋]
Name: sysDescr       [📋]

[Copy All Details]
```

### 実装方法

- `navigator.clipboard.writeText()` APIを使用
- コピー成功時に短いフィードバック（アイコンの変化、またはトースト通知）

## メリット

- 開発者の作業効率が大幅に向上
- OIDを外部ツール（SNMPクライアントなど）で使用する際に便利
- ドキュメント作成時に情報を簡単に引用できる

## 難易度

**低** - 1-2時間程度で実装可能

## 関連issue

- #0 Feature Improvement Roadmap
