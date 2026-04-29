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

class Mutex {
  private queue: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.queue;
    this.queue = this.queue.then(() => next);
    await previous;
    return release;
  }
}

const fileMutexes = new Map<string, Mutex>();

function getFileMutex(filePath: string): Mutex {
  let mutex = fileMutexes.get(filePath);
  if (!mutex) {
    mutex = new Mutex();
    fileMutexes.set(filePath, mutex);
  }
  return mutex;
}

const server = new Server(
  {
    name: "sjis-tools",
    version: "1.0.1",
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
            replaceAll: { type: "boolean", description: "trueの場合、ファイル内のすべての一致箇所を置換します（デフォルト: false）" },
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

  let release: (() => void) | undefined;
  if (resolvedPath && (name === "sjis_read" || name === "sjis_write" || name === "sjis_edit")) {
    const mutex = getFileMutex(resolvedPath);
    release = await mutex.acquire();
  }

  try {
    switch (name) {
      case "sjis_read": {
        if (!existsSync(resolvedPath)) {
          return {
            content: [{ type: "text", text: `Error: File not found: ${resolvedPath}` }],
            isError: true,
          };
        }
        
        try {
          const stat = statSync(resolvedPath);
          if (stat.isDirectory()) {
            return {
              content: [{ type: "text", text: `Error: ${resolvedPath} is a directory, not a file.` }],
              isError: true,
            };
          }
        } catch (e: any) {
          return { content: [{ type: "text", text: `Error reading file stats: ${e.message}` }], isError: true };
        }

        const buffer = readFileSync(resolvedPath);
        const charsetInfo = await detectCharset(resolvedPath);
        const rawContent = readFileWithCharset(buffer, charsetInfo.charset);
        const allLines = rawContent.split('\n');
        const totalLines = allLines.length;

        const MAX_READ_LIMIT = 2000;
        const MAX_LINE_LENGTH = 2000;

        let start = args.startLine !== undefined && !isNaN(Number(args.startLine)) ? Math.max(1, Number(args.startLine)) : 1;
        let end = args.endLine !== undefined && !isNaN(Number(args.endLine)) ? Math.min(totalLines, Number(args.endLine)) : totalLines;

        if (start > totalLines) {
           return {
             content: [{ type: "text", text: `Error: startLine (${start}) exceeds total lines (${totalLines}).` }],
             isError: true,
           };
        }

        // Limit the number of lines read to MAX_READ_LIMIT
        if (end - start + 1 > MAX_READ_LIMIT) {
          end = start + MAX_READ_LIMIT - 1;
        }

        const outputLines: string[] = [];
        outputLines.push(`--- File: ${resolvedPath} (Charset: ${charsetInfo.charset}) ---`);
        outputLines.push(`--- Showing lines ${start} to ${end} of ${totalLines} ---`);
        
        for (let i = start - 1; i < end; i++) {
          let line = allLines[i];
          // Strip carriage return if present
          if (line.endsWith('\r')) line = line.slice(0, -1);
          
          if (line.length > MAX_LINE_LENGTH) {
            line = line.substring(0, MAX_LINE_LENGTH) + " ... (line truncated to 2000 chars)";
          }
          outputLines.push(`${i + 1}: ${line}`);
        }

        if (end < totalLines) {
          outputLines.push(`\n... (Showing lines ${start}-${end} of ${totalLines}. Use startLine=${end + 1} to continue reading.)`);
        }

        return {
          content: [{ type: "text", text: outputLines.join('\n') }],
        };
      }

      case "sjis_write": {
        const contentToWrite = String(args.content);
        const fileExists = existsSync(resolvedPath);
        const charsetInfo = await detectCharset(resolvedPath);
        const charset = charsetInfo.charset === "unknown" ? "shift-jis" : charsetInfo.charset;
        const buffer = encodeContent(contentToWrite, charset as any);
        writeFileSync(resolvedPath, buffer);
        const action = fileExists ? "Overwrote existing file" : "Created new file";
        return {
          content: [{ type: "text", text: `Successfully wrote to ${resolvedPath} in ${charset} (${action})` }],
        };
      }

      case "sjis_edit": {
        const oldText = String(args.oldText);
        const newText = String(args.newText);
        const replaceAll = args.replaceAll === true;

        if (!existsSync(resolvedPath)) {
          return {
            content: [{ type: "text", text: `Error: File not found: ${resolvedPath}` }],
            isError: true,
          };
        }

        if (oldText === newText) {
          return {
            content: [{ type: "text", text: "Warning: oldText and newText are identical. No changes made." }],
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

        const normalizedContent = originalContent.replace(/\r\n/g, '\n');
        const normalizedOldText = oldText.replace(/\r\n/g, '\n');

        if (!normalizedContent.includes(normalizedOldText)) {
          return {
            content: [{ type: "text", text: `Error: Could not find target text in file.` }],
            isError: true,
          };
        }

        const matchCount = normalizedContent.split(normalizedOldText).length - 1;

        if (!replaceAll && matchCount > 1) {
          return {
            content: [{ type: "text", text: `Error: Found ${matchCount} matches for the target text. Set 'replaceAll: true' to replace all, or provide more context in 'oldText' to match only one instance.` }],
            isError: true,
          };
        }

        const newContent = replaceAll
          ? normalizedContent.split(normalizedOldText).join(newText)
          : normalizedContent.replace(normalizedOldText, newText);

        const isCRLF = originalContent.includes('\r\n');
        const finalContent = isCRLF ? newContent.replace(/\n/g, '\r\n') : newContent;

        const newBuffer = encodeContent(finalContent, actualCharset as any);
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
        
        const MAX_MATCHES = 100;
        const MAX_LINE_LENGTH = 2000;
        
        let totalMatches = 0;
        const groupedResults = new Map<string, { lineNum: number; text: string }[]>();
        
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
            const fileMatches: { lineNum: number; text: string }[] = [];
            
            for (let i = 0; i < lines.length; i++) {
              if (totalMatches >= MAX_MATCHES) break;
              const line = lines[i];
              regex.lastIndex = 0;
              if (regex.test(line)) {
                let trimmedLine = line.trim();
                if (trimmedLine.length > MAX_LINE_LENGTH) {
                  trimmedLine = trimmedLine.substring(0, MAX_LINE_LENGTH) + "...";
                }
                fileMatches.push({ lineNum: i + 1, text: trimmedLine });
                totalMatches++;
              }
            }
            
            if (fileMatches.length > 0) {
              groupedResults.set(filePath, fileMatches);
            }
          } catch (e) {
            // ignore read error
          }
        };

        const walk = (targetPath: string) => {
          if (totalMatches >= MAX_MATCHES) return;
          try {
            const stat = statSync(targetPath);
            if (stat.isFile()) {
              searchFile(targetPath, targetPath.split(/[\\/]/).pop() || "");
            } else if (stat.isDirectory()) {
              const files = readdirSync(targetPath);
              for (const file of files) {
                if (totalMatches >= MAX_MATCHES) break;
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
        
        if (totalMatches === 0) {
          return { content: [{ type: "text", text: "No matches found." }] };
        }
        
        const outputLines: string[] = [];
        outputLines.push(`Found ${totalMatches} matches${totalMatches >= MAX_MATCHES ? ` (showing first ${MAX_MATCHES})` : ''}:`);
        outputLines.push("");
        
        for (const [filePath, matches] of groupedResults.entries()) {
          outputLines.push(`${filePath}:`);
          for (const match of matches) {
            outputLines.push(`  Line ${match.lineNum}: ${match.text}`);
          }
          outputLines.push("");
        }
        
        return { content: [{ type: "text", text: outputLines.join('\n').trim() }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  } finally {
    if (release) release();
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
