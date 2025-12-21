# GitHub Issues - Enhancement Proposals

このディレクトリには、MIB Browserの機能改善提案をGitHub issueとして投稿するためのマークダウンファイルが含まれています。

## Issue一覧

### メインissue
- **00-roadmap.md** - 全体のロードマップを管理するメインissue

### 優先度: 高（すぐに実装可能）
1. **01-copy-functionality.md** - コピー機能（OID、詳細情報）
2. **02-toast-notifications.md** - トースト通知システム
3. **03-search-improvements.md** - 検索結果の改善（件数、ナビゲーション）
4. **04-oid-breadcrumb.md** - OIDパスBreadcrumb表示
5. **05-sort-functionality.md** - ソート機能（ファイルリスト、ツリー）

## GitHubへの投稿方法

### 方法1: Web UIで手動作成

1. https://github.com/shmuto/mib-browser/issues/new にアクセス
2. 各マークダウンファイルの内容をコピー&ペースト
3. Label欄に `enhancement` を追加
4. "Submit new issue" をクリック

### 方法2: GitHub CLIを使用（推奨）

GitHub CLIをインストール後、以下のコマンドを実行:

```bash
cd /home/shmuto/project/mib-browser/github-issues

# メインissue
gh issue create --title "Enhancement: Feature Improvement Roadmap" \
  --label "enhancement" \
  --body-file 00-roadmap.md

# 個別issue
gh issue create --title "Enhancement: Add Copy Functionality for OID and Node Details" \
  --label "enhancement" \
  --body-file 01-copy-functionality.md

gh issue create --title "Enhancement: Add Toast Notification System" \
  --label "enhancement" \
  --body-file 02-toast-notifications.md

gh issue create --title "Enhancement: Improve Search Experience" \
  --label "enhancement" \
  --body-file 03-search-improvements.md

gh issue create --title "Enhancement: Add OID Path Breadcrumb Navigation" \
  --label "enhancement" \
  --body-file 04-oid-breadcrumb.md

gh issue create --title "Enhancement: Add Sort Functionality for File List and Tree" \
  --label "enhancement" \
  --body-file 05-sort-functionality.md
```

### 方法3: 一括作成スクリプト

```bash
#!/bin/bash
cd /home/shmuto/project/mib-browser/github-issues

# Issue titles
declare -A titles=(
  ["00-roadmap.md"]="Enhancement: Feature Improvement Roadmap"
  ["01-copy-functionality.md"]="Enhancement: Add Copy Functionality for OID and Node Details"
  ["02-toast-notifications.md"]="Enhancement: Add Toast Notification System"
  ["03-search-improvements.md"]="Enhancement: Improve Search Experience"
  ["04-oid-breadcrumb.md"]="Enhancement: Add OID Path Breadcrumb Navigation"
  ["05-sort-functionality.md"]="Enhancement: Add Sort Functionality for File List and Tree"
)

# Create issues
for file in *.md; do
  if [ "$file" != "README.md" ]; then
    gh issue create --title "${titles[$file]}" \
      --label "enhancement" \
      --body-file "$file"
  fi
done
```

## 注意事項

- issueを作成する前に、重複がないか確認してください
- 各issueには自動的に `enhancement` ラベルが付けられます
- issue番号が確定したら、00-roadmap.mdのチェックリストを更新してください
