import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { stdin } from "node:process";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";

export const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

export class InputLimitError extends Error {
  constructor(limit: number) {
    super(`Input exceeds the ${formatBytes(limit)} decompressed limit`);
    this.name = "InputLimitError";
  }
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

async function readBounded(stream: Readable, maxBytes: number): Promise<string> {
  const decoder = new StringDecoder("utf8");
  const chunks: string[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      stream.destroy();
      throw new InputLimitError(maxBytes);
    }
    chunks.push(decoder.write(buffer));
  }
  chunks.push(decoder.end());
  return chunks.join("");
}

function parseDocuments(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("Input is empty");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (jsonError) {
    const records: unknown[] = [];
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? "";
      if (line.length === 0) continue;
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        const detail = jsonError instanceof Error ? jsonError.message : "invalid JSON";
        throw new Error(`Invalid JSONL at line ${index + 1} (${detail})`);
      }
    }
    if (records.length === 0) throw new Error("Input contains no JSON records");
    return records;
  }
}

export async function loadInput(path: string, maxBytes = DEFAULT_MAX_BYTES): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  let stream: Readable;
  if (path === "-") {
    stream = stdin;
  } else {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Input is not a file: ${path}`);
    if (!path.toLowerCase().endsWith(".gz") && info.size > maxBytes) throw new InputLimitError(maxBytes);
    const file = createReadStream(path);
    stream = path.toLowerCase().endsWith(".gz") ? file.pipe(createGunzip()) : file;
  }
  return parseDocuments(await readBounded(stream, maxBytes));
}

export function parseInputText(text: string): unknown {
  return parseDocuments(text);
}
