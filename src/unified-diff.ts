import { structuredPatch } from "diff";

/**
 * before/after の文字列から標準的な unified diff を生成する。
 * 引数は sjis_patch で iconv.decode した UTF-8 文字列同士を渡す前提のため、
 * 出力は常に UTF-8 テキストになる（Shift-JIS バイト列を直接 diff しない）。
 * 変更がない場合は空文字を返す。
 */
export function buildUnifiedDiff(
  path: string,
  before: string,
  after: string,
  context = 3,
): string {
  const patch = structuredPatch(path, path, before, after, undefined, undefined, { context });
  if (patch.hunks.length === 0) {
    return "";
  }
  const lines: string[] = [`--- ${path}`, `+++ ${path}`];
  for (const hunk of patch.hunks) {
    lines.push(formatHunkHeader(hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines));
    lines.push(...hunk.lines);
  }
  return lines.join("\n");
}

/**
 * hunk header 行。git 準拠: 行数が 1 のときは ",1" を省略する。
 * 行数 0（ファイル末尾への追加など）は省略しない — "-0,0" は「元の行が無い」
 * という意味を持つため "-0" と等価にしてはならない。
 */
function formatHunkHeader(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
): string {
  const oldPart = oldLines === 1 ? `${oldStart}` : `${oldStart},${oldLines}`;
  const newPart = newLines === 1 ? `${newStart}` : `${newStart},${newLines}`;
  return `@@ -${oldPart} +${newPart} @@`;
}
