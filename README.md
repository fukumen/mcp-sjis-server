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

```markdown
## ツール使用とファイル操作のルール

### 重要: Shift-JIS/CP932ファイルの取り扱いルール

#### 事前判定の徹底

ファイルへのアクセス（読み込み・書き込み・編集・検索）が発生する場合、エージェントは処理を行う前に**必ず対象ファイルの文字コードを確認**すること。
具体的には以下疑似Cコードのような確認を行うこと。

```
if (各プロジェクトのトップに `.editorconfig` が存在する) {
  if (`.editorconfig` の charset が shift_jis である) {
    Shift-JIS と断定
  } else {
    UTF-8 と断定
  }
} else if (ファイルのフッターのコメントに Shift-JIS や CP932 の記載がある) {
    Shift-JIS と断定
} else if (`file -i <filepath>` コマンドを実行した結果 UTF-8 である) {
  UTF-8 と断定
} else if (`file -i <filepath>` コマンドを実行した結果 unknown-8bit である) {
  Shift-JIS の可能性が高いが、ユーザーに確認を求める
} else if (`file -i <filepath>` コマンドを実行した結果それ以外) {
  UTF-8 と断定
} else {
  ユーザーに確認を求める
}
```

#### `sjis-tools` の強制適用

判定の結果、文字コードが Shift-JIS または CP932 である場合は、組み込みのファイル操作ツールを使用せず、以下の専用 MCP ツール（`sjis-tools`）を必ず使用すること。
- 読み込み: `sjis_read`
- 書き込み: `sjis_write`
- 編集: `sjis_edit`
- 検索: `sjis_grep`

`sjis-tools` では対応できない git diff などのコマンドを実行するときは `git diff | iconv -f shift_jis -t utf-8` のように変換することで文字化けを回避すること。

※文字コードが UTF-8 などの場合は、通常の組み込みツールを使用すること。

#### 組み込みツール使用禁止の理由

Shift-JIS/CP932 ファイルに対して組み込みツールを使用すると、以下の致命的な問題が発生するため、使用を厳禁とする。
- ファイル編集時にファイル全体が UTF-8 に誤変換される。
- 読み込みや検索の段階で文字化けが発生し、その後の書き込み・編集処理でデータが破損する。
```

