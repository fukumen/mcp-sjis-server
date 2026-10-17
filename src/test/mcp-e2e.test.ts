import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * | patch old（完全一致） | E2E-02, 08 | E2E-03, 08 | E2E-03, 08 |
 * | patch new（そのまま書く） | E2E-02, 03, 08 | E2E-03, 08 | E2E-08 |
 * | patch old（@@ 省略 hunk） | E2E-10(a)(i) | E2E-10(i) | E2E-10(j) |
 * | patch new（@@ 省略 hunk） | E2E-10(a)(i) | E2E-10(i) | E2E-10(j) |
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

    // CR-only ファイル: パッチテキスト内の \r も行区切りなので、CR 行末は bare \r で指定する
    // （"-foo\r-bar" は old 側 "foo\rbar"（CR 行末で区切られた2行）を表す）
    const crPatchFile = join(dir, "cr-patch.txt");
    writeFileSync(crPatchFile, "foo\rbar\rbaz");
    const crPatch =
      "*** Begin Patch\n" +
      `*** Update File: ${crPatchFile}\n` +
      "@@ foo\n" +
      "-foo\r-bar\n" +
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

test("[E2E-06] sjis_grep は正規表現で一致しないときリテラル一致のヒントを返す", async () => {
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

    // "foo(bar)" は正規表現としては foobar に一致するパターンなので、
    // リテラル文字列 foo(bar) を含むファイルには正規表現として一致しない
    const target = join(dir, "hint.txt");
    writeFileSync(target, "foo(bar)\r\nbaz\r\n");
    const res = await request(2, "tools/call", {
      name: "sjis_grep",
      arguments: { pattern: "foo(bar)", path: target },
    });
    const text = res.result.content[0].text;
    assert.match(text, /No regex matches found/);
    assert.match(text, /1 literal match/);
    assert.match(text, /To search literally/);

    // メタ文字を含まないパターンで 0 件のときは従来どおりのメッセージ
    const resNone = await request(3, "tools/call", {
      name: "sjis_grep",
      arguments: { pattern: "quux", path: target },
    });
    assert.equal(resNone.result.content[0].text, "No matches found.");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[E2E-07] sjis_grep の includeGlob はファイル名のglobで拡張子無しファイルも絞り込める", async () => {
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

    const sub = join(dir, "files");
    mkdirSync(sub);
    writeFileSync(join(sub, "Makefile"), "needle makefile\n");
    writeFileSync(join(sub, "a.c"), "needle c\n");
    writeFileSync(join(sub, "readme"), "needle readme\n");
    writeFileSync(join(sub, "data.bin"), "needle bin\n");

    const grep = async (id: number, includeGlob?: string) => {
      const args: Record<string, unknown> = { pattern: "needle", path: sub };
      if (includeGlob !== undefined) args.includeGlob = includeGlob;
      const res = await request(id, "tools/call", { name: "sjis_grep", arguments: args });
      return [...res.result.content[0].text.matchAll(/files[/\\]([^\s:]+)/g)].map((m: RegExpMatchArray) => m[1]);
    };

    // 拡張子のglobは拡張子を持つファイルだけに一致する
    assert.deepEqual(await grep(2, "*.c"), ["a.c"]);
    // 拡張子の無いファイルもファイル名で指定できる
    assert.deepEqual(await grep(3, "Makefile"), ["Makefile"]);
    // ブレース展開で複数パターンを指定できる
    assert.deepEqual((await grep(4, "{a.c,readme}")).sort(), ["a.c", "readme"]);
    // 省略時はバイナリ拡張子（png/pdf/zip 等）のみ除外。.bin はリスト外なので対象
    const all = await grep(5, undefined);
    assert.deepEqual(all.sort(), ["Makefile", "a.c", "data.bin", "readme"]);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[E2E-08] patch モード: hunk 内の行末コードは混在可能（as-is 連結）", async () => {
  // パッチ文字列は \r\n / \r / \n をすべて行区切りとして解析され、内容行は
  // 「プレフィックスの次のバイトから行末コードまで」がそのまま old/new に連結される。
  // 各側の最終行の行末コードだけは hunk の終わりの区切りとして内容に含めない。
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

    // (a) bbbb の行末 CRLF を cccc の行末 LF に置き換える（old/new で行末コードが違う）
    const f1 = join(dir, "replace-eol.txt");
    writeFileSync(f1, iconv.encode("aaaa\r\nbbbb\r\ndddd\nffff\n", "shift-jis"));
    const patch1 =
      "*** Begin Patch\n" +
      `*** Update File: ${f1}\n` +
      "@@ hoge\n" +
      " aaaa\r\n" +
      "-bbbb\r\n" +
      "+cccc\n" +
      " dddd\n" +
      "*** End Patch\n";
    const res1 = await request(2, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch1 },
    });
    assert.match(res1.result.content[0].text, /Successfully patched/);
    assert.equal(
      iconv.decode(readFileSync(f1), "shift-jis"),
      "aaaa\r\ncccc\ndddd\nffff\n",
    );

    // (b) bare CR: パッチテキスト内の \r も行区切りなので、CR 行末は bare \r で指定できる
    const f2 = join(dir, "cr.txt");
    writeFileSync(f2, "aaaa\rbbbb\rdddd\r");
    const patch2 =
      "*** Begin Patch\n" +
      `*** Update File: ${f2}\n` +
      "@@ hoge\r" +
      " aaaa\r" +
      "-bbbb\r" +
      "+CCCC\r" +
      " dddd\r" +
      "*** End Patch\n";
    const res2 = await request(3, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch2 },
    });
    assert.match(res2.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(f2, "utf-8"), "aaaa\rCCCC\rdddd\r");

    // (c) 1つの hunk 内で CR / CRLF / LF が混在する
    const f3 = join(dir, "mixed.txt");
    writeFileSync(f3, "aaaa\rbbbb\r\ndddd\n");
    const patch3 =
      "*** Begin Patch\n" +
      `*** Update File: ${f3}\n` +
      "@@ hoge\n" +
      " aaaa\r" +
      "-bbbb\r\n" +
      "+CCCC\n" +
      " dddd\n" +
      "*** End Patch\n";
    const res3 = await request(4, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch3 },
    });
    assert.match(res3.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(f3, "utf-8"), "aaaa\rCCCC\ndddd\n");

    // (d) 最終行がファイル末尾でも、パッチ文字列の末尾に行末コードが無くても動く
    const f4 = join(dir, "eof-nonl.txt");
    writeFileSync(f4, "aaaa\nbbbb\ndddd");
    const patch4 =
      "*** Begin Patch\n" +
      `*** Update File: ${f4}\n` +
      "@@ hoge\n" +
      " aaaa\n" +
      "-bbbb\n" +
      "+CCCC\n" +
      " dddd\n" +
      "*** End Patch";
    const res4 = await request(5, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch4 },
    });
    assert.match(res4.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(f4, "utf-8"), "aaaa\nCCCC\ndddd");

    // (e) 空の - 行で最終行の行末コードまで消費する（CRLF パッチ）
    const f5 = join(dir, "consume.txt");
    writeFileSync(f5, "aaaa\r\nbbbb\r\n");
    const patch5 =
      "*** Begin Patch\r\n" +
      `*** Update File: ${f5}\r\n` +
      "@@ hoge\r\n" +
      " aaaa\r\n" +
      "-bbbb\r\n" +
      "-\r\n" +
      "+BBBB\n" +
      "*** End Patch\r\n";
    const res5 = await request(6, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch5 },
    });
    assert.match(res5.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(f5, "utf-8"), "aaaa\r\nBBBB");

    // (f) *** End Patch 自体が無いパッチ文字列も解析できる
    const f6 = join(dir, "no-end.txt");
    writeFileSync(f6, "aaaa\nbbbb\n");
    const patch6 =
      "*** Begin Patch\n" +
      `*** Update File: ${f6}\n` +
      "@@ hoge\n" +
      "-bbbb\n" +
      "+BBBB\n";
    const res6 = await request(7, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch6 },
    });
    assert.match(res6.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(f6, "utf-8"), "aaaa\nBBBB\n");

    // (g) *** End Patch の後ろの行はパッチ本体として扱われない
    const f7 = join(dir, "after-end.txt");
    writeFileSync(f7, "aaaa\nbbbb\n");
    const patch7 =
      "*** Begin Patch\n" +
      `*** Update File: ${f7}\n` +
      "@@ hoge\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      "*** End Patch\n" +
      `*** Update File: ${f7}\n` +
      "@@ hoge\n" +
      "-aaaa\n" +
      "+AAAA\n" +
      "*** End Patch\n";
    const res7 = await request(8, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch7 },
    });
    assert.match(res7.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(f7, "utf-8"), "aaaa\nBBBB\n");

    // (h) old 側が空の hunk（+ 行のみ）は挿入位置を特定できないためエラー、ファイルは無変更
    const f8 = join(dir, "add-only.txt");
    writeFileSync(f8, "aaaa\nbbbb\n");
    const patch8 =
      "*** Begin Patch\n" +
      `*** Update File: ${f8}\n` +
      "@@ hoge\n" +
      "+INSERTED\n" +
      "*** End Patch\n";
    const res8 = await request(9, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch8 },
    });
    assert.match(res8.result.content[0].text, /no old lines/);
    assert.equal(readFileSync(f8, "utf-8"), "aaaa\nbbbb\n");

    // (i) old 側がファイル内に複数一致する場合はエラー、ファイルは無変更
    const f9 = join(dir, "multi.txt");
    writeFileSync(f9, "aaaa\nbbbb\naaaa\nbbbb\n");
    const patch9 =
      "*** Begin Patch\n" +
      `*** Update File: ${f9}\n` +
      "@@ hoge\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      "*** End Patch\n";
    const res9 = await request(10, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch9 },
    });
    assert.match(res9.result.content[0].text, /Found 2 matches/);
    assert.equal(readFileSync(f9, "utf-8"), "aaaa\nbbbb\naaaa\nbbbb\n");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[E2E-09] sjis_grep の files_only と context/limit/offset によるページング", async () => {
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

    const sub = join(dir, "files");
    mkdirSync(sub);
    writeFileSync(join(sub, "a.txt"), "needle A\nline2\nline3\nline4\nneedle B\n");
    writeFileSync(join(sub, "b.txt"), "needle C\n");

    const call = async (id: number, extraArgs: Record<string, unknown>) => {
      const res = await request(id, "tools/call", {
        name: "sjis_grep",
        arguments: { pattern: "needle", path: sub, ...extraArgs },
      });
      return res.result.content[0].text as string;
    };

    // files_only: マッチしたファイルパスの一覧のみ返す（マッチ行の内容は含まれない）
    const filesOut = await call(2, { outputMode: "files_only" });
    assert.match(filesOut, /Found 2 file\(s\) with matches:/);
    assert.match(filesOut, /files[/\\]a\.txt/);
    assert.match(filesOut, /files[/\\]b\.txt/);
    assert.doesNotMatch(filesOut, /needle [ABC]/);

    // files_only + offset/limit: ファイル単位のページング
    const filesPaged = await call(3, { outputMode: "files_only", offset: 1, limit: 1 });
    assert.match(filesPaged, /Found 2 file\(s\) with matches \(showing 2\.\.2\):/);
    assert.doesNotMatch(filesPaged, /files[/\\]a\.txt/);
    assert.match(filesPaged, /files[/\\]b\.txt/);

    // context=1: マッチ行の前後1行を含む。離れたマッチは `--` 区切りでブロックが分かれる
    const ctx = await call(4, { context: 1 });
    assert.match(ctx, /Found 3 matches:/);
    assert.match(ctx, /Line 1: needle A/);
    assert.match(ctx, /Line 2: line2/);
    assert.match(ctx, /  --\n  Line 4: line4/);
    assert.match(ctx, /Line 5: needle B/);
    assert.doesNotMatch(ctx, /Line 3: line3/);

    // limit/offset: マッチ単位のページング。総件数はヘッダに含まれる
    const paged1 = await call(5, { limit: 2 });
    assert.match(paged1, /Found 3 matches \(showing 1\.\.2\):/);
    assert.match(paged1, /needle A/);
    assert.match(paged1, /needle B/);
    assert.doesNotMatch(paged1, /needle C/);
    const paged2 = await call(6, { limit: 2, offset: 2 });
    assert.match(paged2, /Found 3 matches \(showing 3\.\.3\):/);
    assert.match(paged2, /needle C/);
    assert.doesNotMatch(paged2, /needle A/);

    // 全件表示のときは showing を含まない
    assert.match(await call(7, {}), /Found 3 matches:\n/);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[E2E-10] patch モード: @@ は V4A どおり省略可能で、適用不能な構造は原因を示してエラーになる", async () => {
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

    // (a) @@ 無しの hunk は V4A 仕様どおり有効（change 行で hunk を開始できる）
    const f1 = join(dir, "no-atat.txt");
    writeFileSync(f1, "aaaa\nbbbb\n");
    const patch1 =
      "*** Begin Patch\n" +
      `*** Update File: ${f1}\n` +
      "-bbbb\n" +
      "+BBBB\n" +
      "*** End Patch\n";
    const res1 = await request(2, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch1 },
    });
    assert.match(res1.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(f1, "utf-8"), "aaaa\nBBBB\n");

    // (b) 後続の空白が無い裸の @@ 行も hunk 開始として扱われる
    const f2 = join(dir, "bare-atat.txt");
    writeFileSync(f2, "aaaa\nbbbb\n");
    const patch2 =
      "*** Begin Patch\n" +
      `*** Update File: ${f2}\n` +
      "@@\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      "*** End Patch\n";
    const res2 = await request(3, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch2 },
    });
    assert.match(res2.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(f2, "utf-8"), "aaaa\nBBBB\n");

    // (c) 連続する @@ 行（V4A の文脈チェーン）は同一 hunk として扱われる
    const f3 = join(dir, "atat-chain.txt");
    writeFileSync(f3, "aaaa\nbbbb\n");
    const patch3 =
      "*** Begin Patch\n" +
      `*** Update File: ${f3}\n` +
      "@@ aaaa\n" +
      "@@ bbbb\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      "*** End Patch\n";
    const res3 = await request(4, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch3 },
    });
    assert.match(res3.result.content[0].text, /Successfully patched .* \(1 edit\)/);
    assert.equal(readFileSync(f3, "utf-8"), "aaaa\nBBBB\n");

    // (d) パッチの外（*** Update File: より前）の change 行は原因と対処を示してエラー
    const patch4 =
      "*** Begin Patch\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      "*** End Patch\n";
    const res4 = await request(5, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch4 },
    });
    assert.equal(res4.result.isError, true);
    assert.match(res4.result.content[0].text, /outside of any \*\*\* Update File: section/);
    assert.match(res4.result.content[0].text, /must come after/);

    // (e) @@ 行が *** Update File: より前にあるパッチはエラー
    const patch5 =
      "*** Begin Patch\n" +
      "@@ hoge\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      "*** End Patch\n";
    const res5 = await request(6, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch5 },
    });
    assert.equal(res5.result.isError, true);
    assert.match(res5.result.content[0].text, /@@ hunk header before any \*\*\* Update File: line/);

    // (f) 未対応ディレクティブ（*** Add File:）はエラーになり、その内容が直前の hunk に混入しない
    const f6 = join(dir, "with-add.txt");
    writeFileSync(f6, "aaaa\nbbbb\n");
    const patch6 =
      "*** Begin Patch\n" +
      `*** Update File: ${f6}\n` +
      "@@ hoge\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      "*** Add File: new.txt\n" +
      "+INSERTED\n" +
      "*** End Patch\n";
    const res6 = await request(7, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch6 },
    });
    assert.equal(res6.result.isError, true);
    assert.match(res6.result.content[0].text, /unsupported patch directive/);
    assert.equal(readFileSync(f6, "utf-8"), "aaaa\nbbbb\n");
    assert.ok(!existsSync(join(dir, "new.txt")));

    // (g) ファイルパスが空の *** Update File: はエラー
    const patch7 =
      "*** Begin Patch\n" +
      "*** Update File: \n" +
      "@@ hoge\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      "*** End Patch\n";
    const res7 = await request(8, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch7 },
    });
    assert.equal(res7.result.isError, true);
    assert.match(res7.result.content[0].text, /empty file path/);

    // (h) hunk の無い *** Update File: はエラー（黙ってスキップされない）
    const f8 = join(dir, "no-hunks.txt");
    writeFileSync(f8, "aaaa\nbbbb\n");
    const patch8 =
      "*** Begin Patch\n" +
      `*** Update File: ${f8}\n` +
      "*** End Patch\n";
    const res8 = await request(9, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch8 },
    });
    assert.equal(res8.result.isError, true);
    assert.match(res8.result.content[0].text, /no hunks found/);
    assert.equal(readFileSync(f8, "utf-8"), "aaaa\nbbbb\n");

    // (i) @@ 省略の hunk でも行末コードは文字データのまま扱われる（CRLF パッチ → CRLF ファイル）
    const f9 = join(dir, "no-atat-crlf.txt");
    writeFileSync(f9, iconv.encode("名前 = 太郎\r\n年齢 = 30\r\n", "shift-jis"));
    const patch9 =
      "*** Begin Patch\r\n" +
      `*** Update File: ${f9}\r\n` +
      " 名前 = 太郎\r\n" +
      "-年齢 = 30\r\n" +
      "+年齢 = 31\r\n" +
      "*** End Patch\r\n";
    const res9 = await request(10, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch9 },
    });
    assert.match(res9.result.content[0].text, /Successfully patched/);
    assert.equal(
      iconv.decode(readFileSync(f9), "shift-jis"),
      "名前 = 太郎\r\n年齢 = 31\r\n",
    );

    // (j) bare CR: @@ 省略の hunk でもパッチ内の \r は行区切りかつ文字データとして扱われる
    //     （E2E-08(b) の @@ 付きパッチと同一構造・同一結果になることの対照試験）
    const f10 = join(dir, "no-atat-cr.txt");
    writeFileSync(f10, "aaaa\rbbbb\rdddd\r");
    const patch10 =
      "*** Begin Patch\n" +
      `*** Update File: ${f10}\n` +
      " aaaa\r" +
      "-bbbb\r" +
      "+BBBB\r" +
      " dddd\r" +
      "*** End Patch\n";
    const res10 = await request(11, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch10 },
    });
    assert.match(res10.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(f10, "utf-8"), "aaaa\rBBBB\rdddd\r");

    // (k) *** Begin Patch を忘れたパッチは Begin 忘れをヒントに示してエラー
    const f11 = join(dir, "no-begin.txt");
    writeFileSync(f11, "aaaa\nbbbb\n");
    const patch11 =
      `*** Update File: ${f11}\n` +
      "-bbbb\n" +
      "+BBBB\n" +
      "*** End Patch\n";
    const res11 = await request(12, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch11 },
    });
    assert.equal(res11.result.isError, true);
    assert.match(res11.result.content[0].text, /No valid patches found/);
    assert.match(res11.result.content[0].text, /must start with a '\*\*\* Begin Patch' line/);
    assert.equal(readFileSync(f11, "utf-8"), "aaaa\nbbbb\n");

    // (l) 空のパッチ（Begin + End のみ）は Update File セクション無しをヒントに示す
    const patch12 = "*** Begin Patch\n*** End Patch\n";
    const res12 = await request(13, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch12 },
    });
    assert.equal(res12.result.isError, true);
    assert.match(res12.result.content[0].text, /contains no '\*\*\* Update File:' sections/);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[E2E-11] sjis_patch/sjis_write は引数漏れを 'undefined' 文字列として処理せずエラーになる", async () => {
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

    // (a) replace モードで oldText/newText を省略しても "undefined" 文字列で置換しない
    const f1 = join(dir, "undef.txt");
    writeFileSync(f1, "x = undefined;\n");
    const res1 = await request(2, "tools/call", {
      name: "sjis_patch",
      arguments: { path: f1 },
    });
    assert.equal(res1.result.isError, true);
    assert.match(res1.result.content[0].text, /oldText and newText are required/);
    assert.equal(readFileSync(f1, "utf-8"), "x = undefined;\n");

    // (b) replace モードに patch パラメータを渡すとエラー（mode 指定漏れの取りこぼし）
    const res2 = await request(3, "tools/call", {
      name: "sjis_patch",
      arguments: { path: f1, patch: "*** Begin Patch\n" },
    });
    assert.equal(res2.result.isError, true);
    assert.match(res2.result.content[0].text, /only valid when mode='patch'/);

    // (c) 不明な mode はエラー（replace モードとして黙って処理しない）
    const res3 = await request(4, "tools/call", {
      name: "sjis_patch",
      arguments: { path: f1, mode: "Patch", oldText: "x = ", newText: "y = " },
    });
    assert.equal(res3.result.isError, true);
    assert.match(res3.result.content[0].text, /mode must be 'replace' or 'patch'/);

    // (d) patch モードで args.path にパッチ対象と同じファイルを指定してもデッドロックしない
    const f4 = join(dir, "same-path.txt");
    writeFileSync(f4, "aaaa\nbbbb\n");
    const patch4 =
      "*** Begin Patch\n" +
      `*** Update File: ${f4}\n` +
      "@@ hoge\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      "*** End Patch\n";
    const res4 = await request(5, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", path: f4, patch: patch4 },
    });
    assert.match(res4.result.content[0].text, /Successfully patched/);
    assert.equal(readFileSync(f4, "utf-8"), "aaaa\nBBBB\n");

    // (e) sjis_write で content を省略しても "undefined" 文字列を書き込まない
    const f5 = join(dir, "keep.txt");
    writeFileSync(f5, "keep\n");
    const res5 = await request(6, "tools/call", {
      name: "sjis_write",
      arguments: { path: f5 },
    });
    assert.equal(res5.result.isError, true);
    assert.match(res5.result.content[0].text, /content parameter is required/);
    assert.equal(readFileSync(f5, "utf-8"), "keep\n");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[E2E-12] patch モード: 1 パッチに複数の Update File セクションと複数 hunk を持てる（V4A 仕様どおり）", async () => {
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

    // (a) 異なる 2 ファイルへの Update File を 1 パッチで適用する
    const f1 = join(dir, "a.txt");
    const f2 = join(dir, "b.txt");
    writeFileSync(f1, "aaaa\nbbbb\n");
    writeFileSync(f2, "cccc\ndddd\n");
    const patch1 =
      "*** Begin Patch\n" +
      `*** Update File: ${f1}\n` +
      "@@ aaaa\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      `*** Update File: ${f2}\n` +
      "@@ cccc\n" +
      "-dddd\n" +
      "+DDDD\n" +
      "*** End Patch\n";
    const res1 = await request(2, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch1 },
    });
    const text1 = res1.result.content[0].text;
    assert.equal((text1.match(/Successfully patched/g) ?? []).length, 2);
    assert.equal(readFileSync(f1, "utf-8"), "aaaa\nBBBB\n");
    assert.equal(readFileSync(f2, "utf-8"), "cccc\nDDDD\n");

    // (b) 同一ファイルへの 2 つの Update File セクションは記述順に適用される
    //     （2 セクション目は 1 セクション目の適用結果に対してマッチする）
    const f3 = join(dir, "c.txt");
    writeFileSync(f3, "aaaa\nbbbb\ncccc\n");
    const patch2 =
      "*** Begin Patch\n" +
      `*** Update File: ${f3}\n` +
      "@@ aaaa\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      `*** Update File: ${f3}\n` +
      "@@ BBBB\n" +
      "-cccc\n" +
      "+CCCC\n" +
      "*** End Patch\n";
    const res2 = await request(3, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch2 },
    });
    const text2 = res2.result.content[0].text;
    assert.equal((text2.match(/Successfully patched/g) ?? []).length, 2);
    assert.equal(readFileSync(f3, "utf-8"), "aaaa\nBBBB\nCCCC\n");

    // (c) 1 つの Update File セクション内の複数 hunk（@@ 区切り）も記述順に適用される
    const f4 = join(dir, "d.txt");
    writeFileSync(f4, "aaaa\nbbbb\ncccc\ndddd\n");
    const patch3 =
      "*** Begin Patch\n" +
      `*** Update File: ${f4}\n` +
      "@@ aaaa\n" +
      "-bbbb\n" +
      "+BBBB\n" +
      "@@ cccc\n" +
      "-dddd\n" +
      "+DDDD\n" +
      "*** End Patch\n";
    const res3 = await request(4, "tools/call", {
      name: "sjis_patch",
      arguments: { mode: "patch", patch: patch3 },
    });
    assert.match(res3.result.content[0].text, /Successfully patched .* \(2 edits\)/);
    assert.equal(readFileSync(f4, "utf-8"), "aaaa\nBBBB\ncccc\nDDDD\n");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
