# mcp-sjis-server

Shift-JIS / CP932 エンコーディングのファイルを透過的に読み書き・編集するための MCP (Model Context Protocol) サーバーです。  
`.editorconfig` の文字コード設定 (`charset = shift_jis` など) を優先し、設定がない場合は自動判定を行ってファイル操作を提供します。

## 機能

- `sjis_read`: ファイルを読み込み、UTF-8 の文字列として返します。
  - 引数: `path` (ファイルパス), `startLine` (オプション: 開始行), `endLine` (オプション: 終了行)
- `sjis_write`: UTF-8 の文字列を受け取り、対象の文字コードでファイルに書き込みます。
  - 引数: `path` (ファイルパス), `content` (書き込むテキスト)
- `sjis_patch`: ファイル内のテキストを置換します。2つのモードを提供します。
  - **replace mode** (デフォルト): 一意の文字列を検索し置換します。変更結果の diff を返します。
    - 引数: `path` (ファイルパス), `oldText` (置換前), `newText` (置換後), `replaceAll` (オプション: 全置換)
  - **patch mode**: V4A フォーマットのパッチを適用し、複数ファイルを一括編集できます。
    - 引数: `mode: "patch"`, `patch` (V4Aパッチ内容)
- `sjis_grep`: 対象ディレクトリ内のファイルから、指定した正規表現パターン（JavaScript/ECMAScript準拠）を検索し、行番号付きで結果を返します。
  - 引数: `pattern` (正規表現パターン), `dirPath` (オプション: 検索対象ディレクトリ), `includeExtension` (オプション: 検索対象とする拡張子), `ignoreCase` (オプション: 大文字小文字を区別しない)

## セットアップ

### インストール

```bash
make install
# または npm install
```

### ビルド

```bash
make build
# または npm run build
```

## MCPクライアントへの登録方法

MCPクライアント（OpenCode や Gemini CLI など）にこのサーバーを登録することで利用可能になります。

**Hermes Agent の設定例 (`~/.hermes/config.yaml`)**:

```yaml
mcp_servers:
  sjis-tools:
    command: node
    args:
    - /home/hogehgoe/mcp-sjis-server/dist/index.js
```

**Pi の設定例 (`~/.pi/agent/mcp.json`)**:

```json
{
  "mcpServers": {
    "sjis-server": {
      "command": "node",
      "args": [
        "/home/hogehgoe/mcp-sjis-server/dist/index.js"
      ],
      "directTools": true
    }
  }
}
```

**OpenCode の設定例 (`~/.config/opencode/opencode.json`)**:

```json
{
  "mcp": {
    "sjis-server": {
      "type": "local",
      "command": [
        "node",
        "/home/hogehoge/mcp-sjis-server/dist/index.js"
      ]
    }
  }
}
```

**Gemini CLI の設定例 (`~/.gemini/settings.json`)**:

```json
{
  "mcpServers": {
    "sjis-server": {
      "command": "node",
      "args": [
        "/home/hogehoge/mcp-sjis-server/dist/index.js"
      ]
    }
  }
}
```

## AGEMNTS.md / GEMINI.md

**設定例**:

````markdown
## ツール使用とファイル操作のルール

ワークスペース内の各プロジェクトには Shift-JIS または CP932 のファイルが含まれている。
Shift-JIS ファイルに対して組み込みツールを使用すると以下の致命的な問題が発生するため、**Shift-JIS ファイルに絶対に組み込みツールを使用してはならい**。

- 組み込みツールによるファイル編集時に Shift-JIS のファイルが UTF-8 に変換されてしまう。
- 組み込みツールによる読み込みや検索の段階で文字化けが発生し、その後の書き込み・編集処理でデータが破損する。

そのため、ファイルへのアクセス（読み込み・書き込み・編集・検索）の前に後述の文字コードの事前判定を必ず行い**Shift-JIS か UTF-8 なのかを判定してから処理を進めること**。

### 文字コードの事前判定

以下疑似Cコードのような判定を行うこと。
文字コードが確定する前に `.editorconfig` の判定するための組み込みツールを使った読み込みは**例外的に認める**。

```
if (各プロジェクトのトップに `.editorconfig` が存在する) {
  if (`.editorconfig` の charset が shift_jis である) {
    `.editorconfig` で指定された拡張子は常に Shift-JIS
  } else {
    `.editorconfig` で指定された拡張子は常に UTF-8
  }
} else {
  `.editorconfig` が存在しないプロジェクトは全て UTF-8
}
```

### Shift-JIS ファイルへのアクセス方法

判定の結果、文字コードが Shift-JIS または CP932 である場合は、組み込みのファイル操作ツールを使用せず、以下の専用 MCP ツール（`sjis-tools`）を必ず使用すること。
- 読み込み: `sjis_read`
- 書き込み: `sjis_write`
- 編集: `sjis_patch`
- 検索: `sjis_grep`

`sjis-tools` では対応できない git diff などのコマンドを実行するときは `git diff | iconv -f shift_jis -t utf-8` のように変換することで文字化けを回避すること。

※文字コードが UTF-8 の場合は、通常の組み込みツールを使用すること。
````

