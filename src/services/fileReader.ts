/**
 * fileReader.ts
 *
 * Two responsibilities:
 *   1. lastNLines(filePath, n, chunkSize)  — reads the last N lines from a
 *      potentially multi-GB file by scanning backwards in fixed-size chunks.
 *      O(N * avg_line_length) reads, O(chunk + N lines) memory.
 *
 *   2. readFrom(filePath, offset)          — reads all complete lines from
 *      `offset` to current end of file. Returns lines and the new byte offset.
 *      Used for incremental streaming after the initial snapshot.
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';

export interface ReadFromResult {
  lines: string[];
  newOffset: number;
  /** Partial line fragment not yet terminated by \n — caller must buffer it */
  remainder: string;
}

/**
 * Read the last `n` lines from `filePath` without loading the whole file.
 */
export async function lastNLines(
  filePath: string,
  n: number,
  chunkSize = 4096
): Promise<string[]> {
  if (n <= 0) return [];

  const fd = await fsPromises.open(filePath, 'r');
  try {
    const stat = await fd.stat();
    const fileSize = stat.size;

    if (fileSize === 0) return [];

    const buf = Buffer.alloc(chunkSize);
    let position = fileSize;
    // We accumulate raw bytes in reverse order, then flip once at the end.
    const chunks: Buffer[] = [];
    let newlineCount = 0;
    let done = false;

    while (position > 0 && !done) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;

      const { bytesRead } = await fd.read(buf, 0, readSize, position);
      // Copy into an independent buffer — buf is reused each iteration so
      // subarray() views would be corrupted by the next read.
      const chunk = Buffer.from(buf.subarray(0, bytesRead));

      // Count newlines from the end of this chunk toward the front.
      // We need n+1 newlines to isolate the last n lines.
      for (let i = bytesRead - 1; i >= 0; i--) {
        if (chunk[i] === 0x0a /* \n */) {
          newlineCount++;
          if (newlineCount > n) {
            // We have more than enough; trim this chunk to just what we need.
            chunks.unshift(chunk.subarray(i + 1));
            done = true;
            break;
          }
        }
      }

      if (!done) {
        chunks.unshift(chunk);
      }
    }

    const combined = Buffer.concat(chunks).toString('utf8');
    const lines = combined.split('\n');

    // Remove empty trailing element caused by a trailing newline.
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }

    return lines.slice(-n);
  } finally {
    await fd.close();
  }
}

/**
 * Read all complete lines appended since `offset`.
 * Returns the lines, the new file offset, and any partial line remainder
 * (content after the last \n that has not yet been terminated).
 *
 * The caller is responsible for prepending a previously buffered remainder
 * before calling this function.
 */
export async function readFrom(
  filePath: string,
  offset: number,
  pendingRemainder = ''
): Promise<ReadFromResult> {
  const stat = await fsPromises.stat(filePath);
  const fileSize = stat.size;

  if (fileSize <= offset) {
    return { lines: [], newOffset: offset, remainder: pendingRemainder };
  }

  const fd = await fsPromises.open(filePath, 'r');
  try {
    const length = fileSize - offset;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buf, 0, length, offset);

    const raw = pendingRemainder + buf.subarray(0, bytesRead).toString('utf8');
    const parts = raw.split('\n');

    // The last element is either '' (file ended with \n) or an unterminated fragment.
    const remainder = parts.pop() ?? '';
    const lines = parts; // all complete lines

    return { lines, newOffset: offset + bytesRead, remainder };
  } finally {
    await fd.close();
  }
}

/**
 * Returns the current size (in bytes) and inode number of a file.
 * Used by LogWatcher to detect truncation and rotation.
 */
export async function statFile(filePath: string): Promise<{ size: number; ino: number }> {
  const stat = await fsPromises.stat(filePath);
  return { size: stat.size, ino: stat.ino };
}

/**
 * Synchronous version used only at startup for the initial snapshot.
 */
export function statFileSync(filePath: string): { size: number; ino: number } {
  const stat = fs.statSync(filePath);
  return { size: stat.size, ino: stat.ino };
}
