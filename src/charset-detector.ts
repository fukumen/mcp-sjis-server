import { parse } from "editorconfig";
import { existsSync } from "fs";
import { dirname, join, isAbsolute } from "path";
import * as iconv from "iconv-lite";

export interface CharsetInfo {
  charset: "utf-8" | "shift-jis" | "unknown";
  source: "editorconfig" | "detection";
}

export async function detectCharset(
  filePath: string,
  worktree?: string
): Promise<CharsetInfo> {
  const resolvedPath = isAbsolute(filePath)
    ? filePath
    : join(worktree || process.cwd(), filePath);

  try {
    const config = await parse(resolvedPath);
    const charsetValue = config.charset;
    if (typeof charsetValue === "string") {
      const charset = charsetValue.toLowerCase();

      if (
        charset === "shift-jis" ||
        charset === "sjis" ||
        charset === "shift_jis" ||
        charset === "cp932" ||
        charset === "windows-932"
      ) {
        return { charset: "shift-jis", source: "editorconfig" };
      }

      if (
        charset === "utf-8" ||
        charset === "utf8" ||
        charset === "utf-8-bom" ||
        charset === "utf-16be" ||
        charset === "utf-16le"
      ) {
        return { charset: "utf-8", source: "editorconfig" };
      }
    }
  } catch {
    // continue to detection
  }

  return { charset: "unknown", source: "detection" };
}

export function detectCharsetFromContent(buffer: Buffer): "utf-8" | "shift-jis" {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(buffer);
    return "utf-8";
  } catch {
    return "shift-jis";
  }
}

export function readFileWithCharset(
  buffer: Buffer,
  charset: "utf-8" | "shift-jis" | "unknown"
): string {
  const actualCharset =
    charset === "unknown" ? detectCharsetFromContent(buffer) : charset;

  if (actualCharset === "shift-jis") {
    // Note: 'cp932' is often better for Windows legacy apps
    return iconv.decode(buffer, "cp932");
  }

  return buffer.toString("utf-8");
}

export function encodeContent(
  content: string,
  charset: "utf-8" | "shift-jis"
): Buffer {
  if (charset === "shift-jis") {
    return iconv.encode(content, "cp932");
  }

  return Buffer.from(content, "utf-8");
}
