import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as iconv from "iconv-lite";

interface Pending {
  resolve: (value: any) => void;
  timer: NodeJS.Timeout;
}

/**
 * dist/index.js を stdio MCP サーバーとして起動し、JSON-RPC で sjis_patch を
 * 実際に呼び出して応答の diff 形式を検証する統合テスト。
 */
function startServer() {
  const child = spawn("node", [join(__dirname, "..", "index.js")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map<number, Pending>();
  let buffer = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const entry = pending.get(msg.id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(msg.id);
          entry.resolve(msg);
        }
      } catch {
        // 不完全な行は無視
      }
    }
  });

  const request = (id: number, method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, 15000);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  const notify = (method: string) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  };

  return { child, request, notify };
}

test("E2E: sjis_patch replace モードが unified diff を返し、SJIS のまま更新する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sjis-e2e-"));
  const { child, request, notify } = startServer();
  try {
    const init = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    assert.ok(init.result.serverInfo.name);
    notify("notifications/initialized");

    // Shift-JIS でテストファイルを作成
    const target = join(dir, "sample.txt");
    writeFileSync(target, iconv.encode("名前: 太郎\n年齢: 30\n住所: 東京都\n", "shift-jis"));

    // replace モード（単一箇所）
    const res = await request(2, "tools/call", {
      name: "sjis_patch",
      arguments: { path: target, oldText: "太郎", newText: "花子" },
    });
    const expected =
      `Successfully edited ${target} in shift-jis (1 replacement)\n` +
      "```diff\n" +
      `--- ${target}\n` +
      `+++ ${target}\n` +
      "@@ -1,3 +1,3 @@\n" +
      "-名前: 太郎\n" +
      "+名前: 花子\n" +
      " 年齢: 30\n" +
      " 住所: 東京都\n" +
      "```";
    assert.equal(res.result.content[0].text, expected);

    // ファイルは Shift-JIS エンコーディングのまま更新されている
    assert.equal(
      iconv.decode(readFileSync(target), "shift-jis"),
      "名前: 花子\n年齢: 30\n住所: 東京都\n",
    );

    // replaceAll: N 箇所置換で (N replacements) と N 箇所分の hunk が出る
    writeFileSync(target, iconv.encode("項目: b\n項目2: b\n項目3: c\n", "shift-jis"));
    const resAll = await request(3, "tools/call", {
      name: "sjis_patch",
      arguments: { path: target, oldText: "b", newText: "X", replaceAll: true },
    });
    const textAll = resAll.result.content[0].text;
    assert.match(textAll, /\(2 replacements\)/);
    assert.equal((textAll.match(/^-.*: b$/gm) ?? []).length, 2);
    assert.equal((textAll.match(/^\+.*: X$/gm) ?? []).length, 2);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E2E: sjis_patch patch モードが hunk 単位の unified diff を返す", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sjis-e2e-"));
  const { child, request, notify } = startServer();
  try {
    const init = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    assert.ok(init.result.serverInfo.name);
    notify("notifications/initialized");

    const target = join(dir, "config.txt");
    writeFileSync(target, iconv.encode("モード = debug\nレベル = 5\nホスト = local\n", "shift-jis"));

    const patch =
      "*** Begin Patch\n" +
      `*** Update File: ${target}\n` +
      "@@ モード = debug\n" +
      "-レベル = 5\n" +
      "+レベル = 10\n" +
      "*** End Patch\n";
    const res = await request(2, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch },
    });
    const expected =
      `Successfully patched ${target} in shift-jis (1 edit)\n` +
      "```diff\n" +
      `--- ${target}\n` +
      `+++ ${target}\n` +
      "@@ -1,3 +1,3 @@\n" +
      " モード = debug\n" +
      "-レベル = 5\n" +
      "+レベル = 10\n" +
      " ホスト = local\n" +
      "```";
    assert.equal(res.result.content[0].text, expected);

    assert.equal(
      iconv.decode(readFileSync(target), "shift-jis"),
      "モード = debug\nレベル = 10\nホスト = local\n",
    );
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
