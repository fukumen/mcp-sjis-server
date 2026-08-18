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
    version: "1.1.0",
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
        description:
                  "Shift JIS/CP932 ファイルを読み込み、UTF-8 文字列として返します。" +
                  "terminal の cat/head/tail の代わりに使用してください。" +
                  "出力形式は 'LINE_NUM|CONTENT'。" +
                  "大きなファイルには startLine と endLine を使用してください。" +
                  "最大2000行まで読み込み可能。" +
                  "1行2000文字を超える場合は切り詰められます。" +
                  "画像やその他のバイナリファイルの読み込みには対応していません。" +
                  "\n\n" +
                  "注意: ファイルの行末（CRLF または LF）はそのまま出力されます。" +
                  "読み込んだ内容を編集する際は、元の行末を維持するよう正しく指定してください。",
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
        description:
                  "Shift JIS/CP932 エンコーディングでファイルを書き込みます。" +
                  "terminal の echo/cat ヒアドキュメントの代わりに使用してください。" +
                  "ファイルの内容を完全に上書きします — 部分的な編集には sjis_patch を使用してください。" +
                  "\n\n" +
                  "注意: content に指定した行末（CRLF または LF）はそのままファイルに書き込まれます。" +
                  "既存ファイルの行末を維持する場合は、読み込んだ内容の行末をそのまま使用してください。",
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
        name: "sjis_patch",
        description:
                  "Shift JIS/CP932 ファイル内のテキストを置換します。" +
                  "terminal の sed/awk の代わりに使用してください。" +
                  "長い文字列や複雑な置換に適しています。" +
                  "変更結果の diff を返します。" +
                  "\n\n" +
                  "REPLACE MODE (mode='replace', デフォルト): " +
                  "ファイル内の一意の文字列を検索し、置換します。" +
                  "REQUIRED PARAMETERS: path, oldText, newText." +
                  "\n\n" +
                  "注意: oldText はファイル内の文字列をそのまま指定してください" +
                  "（行末の正規化は行われません）。" +
                  "CRLF ファイルの場合は oldText にも CRLF を含めて指定する必要があります。" +
                  "\n\n" +
                  "PATCH MODE (mode='patch'): " +
                  "V4A マルチファイルパッチを適用します。" +
                  "REQUIRED PARAMETERS: mode, patch." +
                  "\n\n" +
                  "注意: PATCH MODE は 'Update File' 操作のみをサポートします。" +
                  "'Add File', 'Delete File', 'Move File' は未対応です。" +
                  "パッチ内容は LF で指定してください。",
        inputSchema: {
          type: "object",
          properties: {
            mode: { 
              type: "string", 
              enum: ["replace", "patch"], 
              description: "編集モード。'replace' (デフォルト): 文字列置換。'patch': V4Aマルチファイルパッチ" 
            },
            path: { type: "string", description: "ファイルパス (replace mode用)" },
            oldText: { type: "string", description: "置換前の文字列 (UTF-8) (replace mode用)" },
            newText: { type: "string", description: "置換後の文字列 (UTF-8) (replace mode用)" },
            replaceAll: { type: "boolean", description: "trueの場合、すべての一致箇所を置換 (replace mode用, デフォルト: false)" },
            patch: { 
              type: "string", 
              description: "V4Aフォーマットパッチコンテンツ(patch mode用)。フォーマット:\n*** Begin Patch\n*** Update File: path/to/file\n@@ context hint @@\n context line\n-removed line\n+added line\n*** End Patch" 
            },
          },
        },
      },
      {
        name: "sjis_grep",
        description:
                  "Shift JIS/CP932 エンコーディングのファイルやディレクトリから、" +
                  "指定した正規表現パターン（JavaScript/ECMAScript準守）を検索します。" +
                  "terminal の grep/rg/find の代わりに使用してください。" +
                  ".git ディレクトリとバイナリファイルは自動的に除外されます。" +
                  "検索結果は最大100件まで返されます。" +
                  "includeExtension に拡張子を指定して検索対象を絞り込めます（例: '.c,.txt'）。" +
                  "\n\n" +
                  "注意: 検索結果の行末（CRLF/LF）は元のファイルのままです。",
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
      }
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
  if (resolvedPath && (name === "sjis_read" || name === "sjis_write" || name === "sjis_patch")) {
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
        if (charsetInfo.charset !== "shift-jis") {
          outputLines.push(`⚠️ WARNING: Detected encoding is '${charsetInfo.charset}'. Shift JIS/CP932 was expected.`);
        }
        outputLines.push(`--- Showing lines ${start} to ${end} of ${totalLines} ---`);
        
        for (let i = start - 1; i < end; i++) {
          let line = allLines[i];
          
          if (line.length > MAX_LINE_LENGTH) {
            line = line.substring(0, MAX_LINE_LENGTH) + " ... (line truncated to 2000 chars)";
          }
          outputLines.push(`${i + 1}: ${line}`);
        }

        if (end < totalLines) {
          outputLines.push(`\n... (Showing lines ${start}-${end} of ${totalLines}. Use startLine=${end + 1} to continue reading.)`);
        } else if (end === totalLines) {
          outputLines.push(`--- EOF (reached end of file, ${totalLines} total lines) ---`);
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
        const groupedResults = new Map<string, { charset: string; matches: { lineNum: number; text: string }[] }>();
        
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
              groupedResults.set(filePath, { charset, matches: fileMatches });
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
        
        for (const [filePath, result] of groupedResults.entries()) {
          outputLines.push(`${filePath} (Charset: ${result.charset}):`);
          for (const match of result.matches) {
            outputLines.push(`  Line ${match.lineNum}: ${match.text}`);
          }
          outputLines.push("");
        }
        
        return { content: [{ type: "text", text: outputLines.join('\n').trim() }] };
      }

      case "sjis_patch": {
        const mode = String(args.mode || "replace");
        
        if (mode === "patch") {
          // PATCH MODE: Apply V4A multi-file patches
          const patchContent = String(args.patch || "");
          if (!patchContent) {
            return {
              content: [{ type: "text", text: "Error: patch parameter is required for patch mode." }],
              isError: true,
            };
          }
          
          const results: string[] = [];
          const patchLines = patchContent.split('\n');

          type Edit = { oldLines: string[]; newLines: string[]; contextHint: string };
          type FilePatch = { filePath: string; edits: Edit[] };

          const filePatches: FilePatch[] = [];
          let currentFilePatch: FilePatch | null = null;
          let currentEdit: Edit | null = null;
          let i = 0;
          
          while (i < patchLines.length) {
            const line = patchLines[i];
            
            if (line === "*** Begin Patch") {
              i++;
              while (i < patchLines.length && patchLines[i] !== "*** End Patch") {
                const innerLine = patchLines[i];
                
                if (innerLine.startsWith("*** Update File: ")) {
                  if (currentEdit && currentFilePatch) {
                    currentFilePatch.edits.push(currentEdit);
                    currentEdit = null;
                  }
                  const targetFile = innerLine.substring("*** Update File: ".length).trim();
                  currentFilePatch = { filePath: targetFile, edits: [] };
                  filePatches.push(currentFilePatch);
                } else if (innerLine.startsWith("@@ ")) {
                  if (currentEdit && currentFilePatch) {
                    currentFilePatch.edits.push(currentEdit);
                  }
                  currentEdit = { oldLines: [], newLines: [], contextHint: innerLine };
                } else if (innerLine.startsWith("-")) {
                  if (currentEdit) {
                    currentEdit.oldLines.push(innerLine.substring(1));
                  }
                } else if (innerLine.startsWith("+")) {
                  if (currentEdit) {
                    currentEdit.newLines.push(innerLine.substring(1));
                  }
                } else if (innerLine.startsWith(" ")) {
                  if (currentEdit) {
                    const content = innerLine.substring(1);
                    currentEdit.oldLines.push(content);
                    currentEdit.newLines.push(content);
                  }
                } else if (innerLine === "") {
                  // Empty lines between hunks are skipped (not part of patch content)
                }
                i++;
              }
              
              if (currentEdit && currentFilePatch) {
                currentFilePatch.edits.push(currentEdit);
                currentEdit = null;
              }
              i++;
            } else {
              i++;
            }
          }

          if (filePatches.length === 0) {
            return {
              content: [{ type: "text", text: "Error: No valid patches found in patch parameter." }],
              isError: true,
            };
          }

          for (const filePatch of filePatches) {
            const { filePath: targetFile, edits } = filePatch;
            if (!targetFile || edits.length === 0) continue;

            let patchFileRelease: (() => void) | undefined;
            try {
              const resolvedPatchPath = isAbsolute(targetFile) ? targetFile : join(process.cwd(), targetFile);
              
              if (!existsSync(resolvedPatchPath)) {
                results.push(`Error: File not found: ${resolvedPatchPath}`);
                continue;
              }
              
              const patchMutex = getFileMutex(resolvedPatchPath);
              patchFileRelease = await patchMutex.acquire();
              
              const originalBuffer = readFileSync(resolvedPatchPath);
              const charsetInfo = await detectCharset(resolvedPatchPath);
              const actualCharset = charsetInfo.charset === "unknown"
                ? detectCharsetFromContent(originalBuffer)
                : charsetInfo.charset;
              
              let originalContent: string;
              if (actualCharset === "shift-jis") {
                originalContent = iconv.decode(originalBuffer, "cp932");
              } else {
                originalContent = originalBuffer.toString("utf-8");
              }
              
              let newContent = originalContent;
              let allApplied = true;
              
              for (const edit of edits) {
                const oldText = edit.oldLines.join('\n');
                const newText = edit.newLines.join('\n');
                
                if (!newContent.includes(oldText)) {
                  results.push(`Error: Could not find target text in ${resolvedPatchPath}`);
                  allApplied = false;
                  break;
                }
                
                newContent = newContent.replace(oldText, () => newText);
              }
              
              if (allApplied) {
                const newBuffer = encodeContent(newContent, actualCharset as any);
                writeFileSync(resolvedPatchPath, newBuffer);

                const diffLines: string[] = [];
                diffLines.push(`--- ${resolvedPatchPath}`);
                diffLines.push(`+++ ${resolvedPatchPath}`);
                for (const edit of edits) {
                  if (edit.contextHint) {
                    diffLines.push(edit.contextHint);
                  }
                  for (const oldL of edit.oldLines) {
                    diffLines.push(`-${oldL}`);
                  }
                  for (const newL of edit.newLines) {
                    diffLines.push(`+${newL}`);
                  }
                }

                results.push(`Successfully patched ${resolvedPatchPath} in ${actualCharset}\n\`\`\`diff\n${diffLines.join('\n')}\n\`\`\``);
              }
            } catch (e: any) {
              results.push(`Error patching ${targetFile}: ${e.message}`);
            } finally {
              if (patchFileRelease) patchFileRelease();
            }
          }
          
          return {
            content: [{ type: "text", text: results.join('\n\n') }],
          };
        }
        
        // REPLACE MODE: find and replace text (as-is, no line ending normalization)
        const oldText = String(args.oldText);
        const newText = String(args.newText);
        const replaceAll = args.replaceAll === true;
        
        if (oldText === "") {
          return {
            content: [{ type: "text", text: "Error: oldText parameter is required and cannot be empty." }],
            isError: true,
          };
        }
        
        if (oldText === newText) {
          return {
            content: [{ type: "text", text: "Warning: oldText and newText are identical. No changes made." }],
          };
        }
        
        if (!resolvedPath) {
          return {
            content: [{ type: "text", text: "Error: path parameter is required for replace mode." }],
            isError: true,
          };
        }
        
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
        
        const matchCount = originalContent.split(oldText).length - 1;
        
        if (!replaceAll && matchCount > 1) {
          return {
            content: [{ type: "text", text: `Error: Found ${matchCount} matches for the target text. Set 'replaceAll: true' to replace all, or provide more context in 'oldText' to match only one instance.` }],
            isError: true,
          };
        }
        
        const newContent = replaceAll
          ? originalContent.split(oldText).join(newText)
          : originalContent.replace(oldText, () => newText);
        
        const newBuffer = encodeContent(newContent, actualCharset as any);
        writeFileSync(resolvedPath, newBuffer);

        // Diff: show what changed
        const diffLines: string[] = [];
        diffLines.push(`--- ${resolvedPath}`);
        diffLines.push(`+++ ${resolvedPath}`);
        for (const line of oldText.split('\n')) {
          diffLines.push(`-${line}`);
        }
        for (const line of newText.split('\n')) {
          diffLines.push(`+${line}`);
        }
        
        return {
          content: [{ type: "text", text: `Successfully edited ${resolvedPath} in ${actualCharset}\n\`\`\`diff\n${diffLines.join('\n')}\n\`\`\`` }],
        };
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
