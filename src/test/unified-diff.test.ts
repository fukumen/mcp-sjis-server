import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUnifiedDiff } from "../unified-diff.js";

test("部分行置換は行単位の -/+ ペアと context 付き hunk になる", () => {
  const diff = buildUnifiedDiff(
    "/tmp/a.txt",
    "const x = 1;\nconst y = 2;\n",
    "const x = 10;\nconst y = 2;\n",
  );
  assert.equal(
    diff,
    [
      "--- /tmp/a.txt",
      "+++ /tmp/a.txt",
      "@@ -1,2 +1,2 @@",
      "-const x = 1;",
      "+const x = 10;",
      " const y = 2;",
    ].join("\n"),
  );
});

test("離れた複数箇所の置換は複数 hunk に分かれる", () => {
  // context 3 のとき hunk が分かれるには変更箇所の間隔が context×2 以上必要
  const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  const before = lines.join("\n") + "\n";
  const after = lines
    .map((l, i) => (i === 1 ? "CHANGED_A" : i === 17 ? "CHANGED_B" : l))
    .join("\n") + "\n";
  const diff = buildUnifiedDiff("/tmp/b.txt", before, after);
  const headers = diff.split("\n").filter((l) => l.startsWith("@@"));
  assert.equal(headers.length, 2);
  assert.ok(diff.includes("-line2"));
  assert.ok(diff.includes("+CHANGED_A"));
  assert.ok(diff.includes("-line18"));
  assert.ok(diff.includes("+CHANGED_B"));
});

test("近接した複数箇所の置換は1つの hunk にまとまる", () => {
  const before = "a\nb\nc\na\nb\nc\na\nb\nc\n";
  const after = "a\nb\nX\na\nb\nX\na\nb\nc\n";
  const diff = buildUnifiedDiff("/tmp/c.txt", before, after);
  assert.equal(diff.split("\n").filter((l) => l.startsWith("@@")).length, 1);
  assert.equal(diff.split("\n").filter((l) => l === "-c").length, 2);
  assert.equal(diff.split("\n").filter((l) => l === "+X").length, 2);
});

test("行数1の hunk は git 準拠で ',1' を省略する", () => {
  const diff = buildUnifiedDiff("/tmp/d.txt", "foo\n", "foo\nbar\n");
  assert.ok(diff.includes("@@ -1 +1,2 @@"));
  assert.ok(diff.includes(" foo"));
  assert.ok(diff.includes("+bar"));
});

test("行数0は ',0' を省略しない", () => {
  // 空ファイルからの追加: 旧側は 0 行
  const diff = buildUnifiedDiff("/tmp/e0.txt", "", "foo\nbar\n");
  assert.ok(diff.includes("@@ -1,0 +1,2 @@"));
  assert.ok(diff.includes("+foo"));
  assert.ok(diff.includes("+bar"));
});

test("末尾改行なしは \\ No newline at end of file を出す", () => {
  const diff = buildUnifiedDiff("/tmp/e.txt", "foo\nbar", "foo\nbaz");
  assert.ok(diff.includes("\\ No newline at end of file"));
});

test("変更なしは空文字を返す", () => {
  assert.equal(buildUnifiedDiff("/tmp/f.txt", "same\n", "same\n"), "");
});

test("CRLF の \\r は行末に保持される", () => {
  const diff = buildUnifiedDiff("/tmp/g.txt", "foo\r\nbar\r\n", "foo\r\nbaz\r\n");
  assert.ok(diff.includes(" foo\r"));
  assert.ok(diff.includes("-bar\r"));
  assert.ok(diff.includes("+baz\r"));
});

test("Shift-JIS からデコードしたマルチバイト文字が正しく diff に出る", () => {
  const diff = buildUnifiedDiff(
    "/tmp/h.txt",
    "名前: 太郎\n年齢: 30\n",
    "名前: 花子\n年齢: 30\n",
  );
  assert.ok(diff.includes("-名前: 太郎"));
  assert.ok(diff.includes("+名前: 花子"));
  assert.ok(diff.includes(" 年齢: 30"));
});

test("context 行数を指定できる", () => {
  const before = "1\n2\n3\n4\n5\n";
  const after = "1\n2\nX\n4\n5\n";
  const diff = buildUnifiedDiff("/tmp/i.txt", before, after, 0);
  assert.ok(diff.includes("@@ -3 +3 @@\n-3\n+X"));
});
