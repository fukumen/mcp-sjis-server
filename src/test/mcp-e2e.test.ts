import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as iconv from "iconv-lite";

/**
 * 行末コード（LF / CRLF / CR）の網羅マトリクス。セル = その行末コードを検証するテストID
 * （テスト名先頭の [E2E-nn] / [UD-nn]。npm test の出力でも確認できる）。
 *
 * | 対象                       | LF | CRLF | CR |
 * |----------------------------|----|------|----|
 * | replace old（完全一致） | E2E-04 | E2E-04 | E2E-04 |
 * | replace new（そのまま書く） | E2E-04 | E2E-04 | E2E-04 |
 * | patch old（完全一致） | E2E-02 | E2E-03 | E2E-03 |
 * | patch new（そのまま書く） | E2E-02, 03 | E2E-03 | E2E-03 |
 * | read（行区切り表示） | E2E-05 | E2E-05 | E2E-05 |
 * | grep（行区切り表示） | E2E-05 | E2E-05 | E2E-05 |
 * | diff（行内容の保持） | UD-01～03 | UD-08 | UD-09 |
 *
 * 空セルは「未検証」を意味する。行末挙動を変更したら対応する ID のテストを更新し、
 * 新しい行末形式は列を増やして埋める。
 *
 * 契約: 行末コードは文字データであり、どの層でも値を変換・正規化しない。
 * old 側は文字が一致した場合のみ置換する（E2E-04 の不一致ケースで検証）。
 */

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

test("[E2E-01] sjis_patch replace モードが unified diff を返し、SJIS のまま更新する", async () => {
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

test("[E2E-02] sjis_patch patch モードが hunk 単位の unified diff を返す", async () => {
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

test("[E2E-03] sjis_patch patch モードは行末コードを文字として扱う", async () => {
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

    // CRLF 行末で書かれたパッチ（構文行も CRLF）で CRLF ファイルを CRLF のまま更新できる
    const target = join(dir, "crlf.txt");
    writeFileSync(target, iconv.encode("名前 = 太郎\r\n年齢 = 30\r\n", "shift-jis"));
    const crlfPatch =
      "*** Begin Patch\r\n" +
      `*** Update File: ${target}\r\n` +
      "@@ 名前 = 太郎\r\n" +
      " 名前 = 太郎\r\n" +
      "-年齢 = 30\r\n" +
      "+年齢 = 31\r\n" +
      "*** End Patch\r\n";
    const res = await request(2, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: crlfPatch },
    });
    assert.match(res.result.content[0].text, /Successfully patched/);
    assert.equal(
      iconv.decode(readFileSync(target), "shift-jis"),
      "名前 = 太郎\r\n年齢 = 31\r\n",
    );

    // 極端なケース: old 側はファイルの CRLF、new 側に LF を書くと、
    // 指定された文字の通りその位置の行末が CRLF から LF に置き換わる
    const mixed = join(dir, "mixed.txt");
    writeFileSync(mixed, iconv.encode("A = 1\r\nB = 2\n", "shift-jis"));
    const mixedPatch =
      "*** Begin Patch\n" +
      `*** Update File: ${mixed}\n` +
      "@@ A = 1\n" +
      "-A = 1\r\n" +
      "-B = 2\n" +
      "+A = 10\n" +
      "+B = 20\n" +
      "*** End Patch\n";
    const resMixed = await request(3, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: mixedPatch },
    });
    assert.match(resMixed.result.content[0].text, /Successfully patched/);
    assert.equal(
      iconv.decode(readFileSync(mixed), "shift-jis"),
      "A = 10\nB = 20\n",
    );

    // new 側の行に \r を書くと、LF ファイルに CRLF がそのまま書き込まれる
    const lf = join(dir, "lf.txt");
    writeFileSync(lf, "A\nB\n");
    const lfPatch =
      "*** Begin Patch\n" +
      `*** Update File: ${lf}\n` +
      "@@ A\n" +
      "-A\n" +
      "-B\n" +
      "+C\r\n" +
      "+D\n" +
      "*** End Patch\n";
    const resLf = await request(4, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: lfPatch },
    });
    assert.match(resLf.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(lf, "utf-8"), "C\r\nD\n");

    // old 側の行内の単独 \r で CR-only ファイルに一致する（CR は文字として扱う）
    const crPatchFile = join(dir, "cr-patch.txt");
    writeFileSync(crPatchFile, "foo\rbar\rbaz");
    const crPatch =
      "*** Begin Patch\n" +
      `*** Update File: ${crPatchFile}\n` +
      "@@ foo\n" +
      "-foo\rbar\n" +
      "+FOO\n" +
      "+BAR\n" +
      "*** End Patch\n";
    const resCrPatch = await request(5, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: crPatch },
    });
    assert.match(resCrPatch.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(crPatchFile, "utf-8"), "FOO\nBAR\rbaz");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[E2E-04] sjis_patch replace モードも行末コードを文字として扱う", async () => {
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

    // oldText の \r\n は文字として一致し、newText の \n がそのまま書き込まれる
    const crlfFile = join(dir, "crlf.txt");
    writeFileSync(crlfFile, "A\r\nB\r\n");
    const res1 = await request(2, "tools/call", {
      name: "sjis_patch",
      arguments: { path: crlfFile, oldText: "A\r\nB", newText: "C\nD" },
    });
    assert.match(res1.result.content[0].text, /Successfully edited/);
    assert.equal(readFileSync(crlfFile, "utf-8"), "C\nD\r\n");

    // 逆に newText に \r\n を書くと、LF ファイルに CRLF がそのまま書き込まれる
    const lfFile = join(dir, "lf.txt");
    writeFileSync(lfFile, "A\nB\n");
    const res2 = await request(3, "tools/call", {
      name: "sjis_patch",
      arguments: { path: lfFile, oldText: "A\nB", newText: "C\r\nD" },
    });
    assert.match(res2.result.content[0].text, /Successfully edited/);
    assert.equal(readFileSync(lfFile, "utf-8"), "C\r\nD\n");

    // old 側の行末コードが違えば正規化されないので一致しない（ファイルは無変更）
    const crlfFile2 = join(dir, "crlf2.txt");
    writeFileSync(crlfFile2, "A\r\nB\r\n");
    const res3 = await request(4, "tools/call", {
      name: "sjis_patch",
      arguments: { path: crlfFile2, oldText: "A\nB", newText: "X\nY" },
    });
    assert.equal(res3.result.isError, true);
    assert.match(res3.result.content[0].text, /Could not find target text/);
    assert.equal(readFileSync(crlfFile2, "utf-8"), "A\r\nB\r\n");

    // old 側の単独 \r も文字として一致する（CR-only ファイル）
    const crFile = join(dir, "cr.txt");
    writeFileSync(crFile, "A\rB\rC");
    const res4 = await request(5, "tools/call", {
      name: "sjis_patch",
      arguments: { path: crFile, oldText: "A\rB", newText: "X\nY" },
    });
    assert.match(res4.result.content[0].text, /Successfully edited/);
    assert.equal(readFileSync(crFile, "utf-8"), "X\nY\rC");

    // new 側の単独 \r も指定文字どおりに書かれる
    const res5 = await request(6, "tools/call", {
      name: "sjis_patch",
      arguments: { path: crFile, oldText: "X\nY", newText: "P\rQ" },
    });
    assert.match(res5.result.content[0].text, /Successfully edited/);
    assert.equal(readFileSync(crFile, "utf-8"), "P\rQ\rC");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[E2E-05] sjis_read/sjis_grep は行末コードを元のデータのまま返す", async () => {
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

    // sjis_read: CRLF の \r は各行末の文字としてそのまま出力される
    const crlfFile = join(dir, "crlf.txt");
    writeFileSync(crlfFile, "X\r\nY\r\n");
    const resRead = await request(2, "tools/call", {
      name: "sjis_read",
      arguments: { path: crlfFile },
    });
    assert.match(resRead.result.content[0].text, /1: X\r\n2: Y\r\n/);

    // sjis_read: LF ファイルの出力に \r は出現しない
    const lfFile = join(dir, "lf.txt");
    writeFileSync(lfFile, "A\nB\n");
    const resReadLf = await request(3, "tools/call", {
      name: "sjis_read",
      arguments: { path: lfFile },
    });
    assert.ok(!resReadLf.result.content[0].text.includes("\r"));

    // sjis_grep: マッチ行の \r も元のデータのまま返る（最終行も含む）
    const resGrep = await request(4, "tools/call", {
      name: "sjis_grep",
      arguments: { pattern: "X|Y", path: crlfFile },
    });
    assert.match(resGrep.result.content[0].text, /Line 1: X\r\n/);
    assert.match(resGrep.result.content[0].text, /Line 2: Y\r/);

    // sjis_grep: LF ファイルのマッチ行に \r は出現しない
    const resGrepLf = await request(5, "tools/call", {
      name: "sjis_grep",
      arguments: { pattern: "A|B", path: lfFile },
    });
    assert.ok(!resGrepLf.result.content[0].text.includes("\r"));

    // 行区切りの表示では CR / LF / CRLF を等しく扱う（行番号が付き、\r は文字として残る）
    const crFile = join(dir, "cr.txt");
    writeFileSync(crFile, "P\rQ\rR");
    const resReadCr = await request(6, "tools/call", {
      name: "sjis_read",
      arguments: { path: crFile },
    });
    assert.match(resReadCr.result.content[0].text, /1: P\r\n2: Q\r\n3: R\n/);

    const resGrepCr = await request(7, "tools/call", {
      name: "sjis_grep",
      arguments: { pattern: "Q|R", path: crFile },
    });
    assert.match(resGrepCr.result.content[0].text, /Line 2: Q\r\n/);
    assert.match(resGrepCr.result.content[0].text, /Line 3: R/);

    // CRLF / LF / CR 混在ファイル: 各行が元の行末コードを保ったまま返る
    const mixed = join(dir, "mixed.txt");
    writeFileSync(mixed, "A\r\nB\nC\rD\r\n");
    const resReadMixed = await request(8, "tools/call", {
      name: "sjis_read",
      arguments: { path: mixed },
    });
    assert.match(
      resReadMixed.result.content[0].text,
      /1: A\r\n2: B\n3: C\r\n4: D\r\n5: \n--- EOF/,
    );

    const resGrepMixed = await request(9, "tools/call", {
      name: "sjis_grep",
      arguments: { pattern: "A|B|C|D", path: mixed },
    });
    assert.match(resGrepMixed.result.content[0].text, /Line 1: A\r\n/);
    assert.match(resGrepMixed.result.content[0].text, /Line 2: B\n/);
    assert.match(resGrepMixed.result.content[0].text, /Line 3: C\r\n/);
    assert.match(resGrepMixed.result.content[0].text, /Line 4: D\r\n/);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
