import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { isAbsolute, join } from "path";
import {
  detectCharset,
  detectCharsetFromContent,
  encodeContent,
  readFileWithCharset,
} from "./charset-detector.js";
import * as iconv from "iconv-lite";

const server = new Server(
  {
    name: "sjis-tools",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "sjis_read",
        description: "Shift JIS/CP932 のファイルを読み込み、UTF-8 文字列として返します。",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "ファイルパス" },
            startLine: { type: "number", description: "読み込みを開始する行番号（1始まり）" },
            endLine: { type: "number", description: "読み込みを終了する行番号（1始まり）" },
          },
          required: ["path"],
        },
      },
      {
        name: "sjis_write",
        description: "Shift JIS/CP932 エンコーディングでファイルを書き込みます。",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "ファイルパス" },
            content: { type: "string", description: "書き込む UTF-8 文字列" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "sjis_edit",
        description: "Shift JIS/CP932 ファイル内のテキストを置換します。",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "ファイルパス" },
            oldText: { type: "string", description: "置換前の文字列 (UTF-8)" },
            newText: { type: "string", description: "置換後の文字列 (UTF-8)" },
          },
          required: ["path", "oldText", "newText"],
        },
      },
      {
        name: "sjis_grep",
        description: "Shift JIS/CP932 エンコーディングのファイルやディレクトリから、指定した正規表現パターン（JavaScript/ECMAScript準拠）を検索します。",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "検索する正規表現パターン（JavaScript準拠）" },
            dirPath: { type: "string", description: "検索対象のディレクトリまたはファイルパス（デフォルト: カレントディレクトリ）" },
            includeExtension: { type: "string", description: "検索対象とする拡張子（例: .c,.txt）" },
            ignoreCase: { type: "boolean", description: "大文字小文字を区別するかどうか（デフォルト: false）" },
          },
          required: ["pattern"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new McpError(ErrorCode.InvalidParams, "Arguments are required");
  }

  const filePath = args.path ? String(args.path) : "";
  const resolvedPath = filePath ? (isAbsolute(filePath) ? filePath : join(process.cwd(), filePath)) : "";

  try {
    switch (name) {
      case "sjis_read": {
        if (!existsSync(resolvedPath)) {
          return {
            content: [{ type: "text", text: `Error: File not found: ${resolvedPath}` }],
            isError: true,
          };
        }
        const buffer = readFileSync(resolvedPath);
        const charsetInfo = await detectCharset(resolvedPath);
        let content = readFileWithCharset(buffer, charsetInfo.charset);

        const startLine = args.startLine !== undefined ? Number(args.startLine) : undefined;
        const endLine = args.endLine !== undefined ? Number(args.endLine) : undefined;

        if (startLine !== undefined || endLine !== undefined) {
          const lines = content.split('\n');
          const start = startLine !== undefined && !isNaN(startLine) ? Math.max(1, startLine) - 1 : 0;
          const end = endLine !== undefined && !isNaN(endLine) ? Math.min(lines.length, endLine) : lines.length;
          content = lines.slice(start, end).join('\n');
        }

        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "sjis_write": {
        const contentToWrite = String(args.content);
        const charsetInfo = await detectCharset(resolvedPath);
        const charset = charsetInfo.charset === "unknown" ? "shift-jis" : charsetInfo.charset;
        const buffer = encodeContent(contentToWrite, charset as any);
        writeFileSync(resolvedPath, buffer);
        return {
          content: [{ type: "text", text: `Successfully wrote to ${resolvedPath} in ${charset}` }],
        };
      }

      case "sjis_edit": {
        const oldText = String(args.oldText);
        const newText = String(args.newText);

        if (!existsSync(resolvedPath)) {
          return {
            content: [{ type: "text", text: `Error: File not found: ${resolvedPath}` }],
            isError: true,
          };
        }

        const originalBuffer = readFileSync(resolvedPath);
        const charsetInfo = await detectCharset(resolvedPath);
        const actualCharset = charsetInfo.charset === "unknown"
          ? detectCharsetFromContent(originalBuffer)
          : charsetInfo.charset;

        let originalContent: string;
        if (actualCharset === "shift-jis") {
          originalContent = iconv.decode(originalBuffer, "cp932");
        } else {
          originalContent = originalBuffer.toString("utf-8");
        }

        if (!originalContent.includes(oldText)) {
          return {
            content: [{ type: "text", text: `Error: Could not find target text in file.` }],
            isError: true,
          };
        }

        const newContent = originalContent.replace(oldText, newText);
        const newBuffer = encodeContent(newContent, actualCharset as any);
        writeFileSync(resolvedPath, newBuffer);

        return {
          content: [{ type: "text", text: `Successfully edited ${resolvedPath} in ${actualCharset}` }],
        };
      }

      case "sjis_grep": {
        const pattern = String(args.pattern);
        const dirPath = args.dirPath ? String(args.dirPath) : process.cwd();
        const includeExt = args.includeExtension ? String(args.includeExtension) : "";
        const ignoreCase = args.ignoreCase === true;
        
        const resolvedDirPath = isAbsolute(dirPath) ? dirPath : join(process.cwd(), dirPath);
        if (!existsSync(resolvedDirPath)) {
          return { content: [{ type: "text", text: `Error: Directory not found: ${resolvedDirPath}` }], isError: true };
        }

        const IGNORED_DIRS = new Set([".git"]);
        const exts = includeExt.split(',').map(e => e.trim().toLowerCase()).filter(e => e.length > 0);
        
        const results: string[] = [];
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
        } catch (e: any) {
          return { content: [{ type: "text", text: `Error: Invalid RegExp pattern: ${e.message}` }], isError: true };
        }
        
        const searchFile = (filePath: string, fileName: string) => {
          if (exts.length > 0) {
            const lowerName = fileName.toLowerCase();
            if (!exts.some(ext => lowerName.endsWith(ext))) return;
          } else {
            const lowerName = fileName.toLowerCase();
            if (lowerName.match(/\.(png|jpg|jpeg|gif|ico|pdf|zip|tar|gz|exe|dll|db|sqlite|sqlite3|class|jar|webp)$/)) return;
          }
          
          try {
            const buffer = readFileSync(filePath);
            const charset = detectCharsetFromContent(buffer);
            let content = "";
            if (charset === "shift-jis") {
              content = iconv.decode(buffer, "cp932");
            } else {
              content = buffer.toString("utf-8");
            }
            
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              regex.lastIndex = 0;
              if (regex.test(line)) {
                results.push(`${filePath}:${i + 1}:${line.trim()}`);
                if (results.length >= 1000) break;
              }
            }
          } catch (e) {
            // ignore read error
          }
        };

        const walk = (targetPath: string) => {
          if (results.length >= 1000) return;
          try {
            const stat = statSync(targetPath);
            if (stat.isFile()) {
              searchFile(targetPath, targetPath.split(/[\\/]/).pop() || "");
            } else if (stat.isDirectory()) {
              const files = readdirSync(targetPath);
              for (const file of files) {
                if (results.length >= 1000) break;
                if (IGNORED_DIRS.has(file)) continue;
                
                const fullPath = join(targetPath, file);
                try {
                  const s = statSync(fullPath);
                  if (s.isDirectory()) {
                    walk(fullPath);
                  } else if (s.isFile()) {
                    searchFile(fullPath, file);
                  }
                } catch (e) { continue; }
              }
            }
          } catch (e) {
            // ignore
          }
        };

        walk(resolvedDirPath);
        
        if (results.length === 0) {
          return { content: [{ type: "text", text: "No matches found." }] };
        }
        
        let output = results.join('\n');
        if (results.length >= 1000) {
          output += '\n... (truncated to 1000 results)';
        }
        return { content: [{ type: "text", text: output }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Shift JIS Tools MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
