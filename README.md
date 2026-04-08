# mcp-sjis-server

Shift-JIS / CP932 エンコーディングのファイルを透過的に読み書き・編集するための MCP (Model Context Protocol) サーバーです。  
`.editorconfig` の文字コード設定 (`charset = shift_jis` など) を優先し、設定がない場合は自動判定を行ってファイル操作を提供します。

## 機能

- `sjis_read`: ファイルを読み込み、UTF-8 の文字列として返します。
  - 引数: `path` (ファイルパス), `startLine` (オプション: 開始行), `endLine` (オプション: 終了行)
- `sjis_write`: UTF-8 の文字列を受け取り、対象の文字コードでファイルに書き込みます。
  - 引数: `path` (ファイルパス), `content` (書き込むテキスト)
- `sjis_edit`: ファイル内の特定テキスト（UTF-8）を検索し、置換した上で保存します。
  - 引数: `path` (ファイルパス), `oldText` (置換前), `newText` (置換後)
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

```markdown
## プロジェクト構成と規約 (Project Conventions)
- **.editorconfig の遵守**: プロジェクトルートやそのサブディレクトリに `.editorconfig` が存在する場合、そこに定義されている改行コード (EOL)、インデント、文字コード等の設定を最優先で遵守すること。
  - **Shift-JIS/CP932 ファイルの編集**:
    - **判定基準**: `.editorconfig` の `charset` 設定が `shift_jis` または `cp932` の場合、または自動判定で Shift-JIS/CP932 と検出された場合
    - 組み込みツールを使用するとファイル全体が utf-8 に変換されてしまうため、使用禁止。必ず以下 4 つのカスタムツールを使用すること。
      - **読み込み**: `sjis_read` ツールを使用
      - **書き込み**: `sjis_write` ツールを使用
      - **編集**: `sjis_edit` ツールを使用
      - **grep**: `sjis_grep` ツールを使用
```

