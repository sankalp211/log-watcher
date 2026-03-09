import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lastNLines, readFrom } from '../../src/services/fileReader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempFile(content: string): string {
  const file = path.join(os.tmpdir(), `log-watcher-test-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function cleanup(...files: string[]): void {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// lastNLines
// ---------------------------------------------------------------------------

describe('lastNLines', () => {

  // ----- basic correctness --------------------------------------------------

  test('returns last 10 lines of a 20-line file', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const file = makeTempFile(lines.join('\n') + '\n');
    try {
      const result = await lastNLines(file, 10);
      expect(result).toHaveLength(10);
      expect(result[0]).toBe('line 11');
      expect(result[9]).toBe('line 20');
    } finally { cleanup(file); }
  });

  test('returns all lines when file has fewer than N lines', async () => {
    const file = makeTempFile('alpha\nbeta\ngamma\n');
    try {
      expect(await lastNLines(file, 10)).toEqual(['alpha', 'beta', 'gamma']);
    } finally { cleanup(file); }
  });

  test('returns empty array for empty file', async () => {
    const file = makeTempFile('');
    try {
      expect(await lastNLines(file, 10)).toEqual([]);
    } finally { cleanup(file); }
  });

  test('returns the only line when file has exactly 1 line', async () => {
    const file = makeTempFile('only line\n');
    try {
      expect(await lastNLines(file, 10)).toEqual(['only line']);
    } finally { cleanup(file); }
  });

  test('returns exactly 1 line when n=1', async () => {
    const file = makeTempFile('first\nsecond\nthird\n');
    try {
      expect(await lastNLines(file, 1)).toEqual(['third']);
    } finally { cleanup(file); }
  });

  test('returns empty array when n=0', async () => {
    const file = makeTempFile('a\nb\n');
    try {
      expect(await lastNLines(file, 0)).toEqual([]);
    } finally { cleanup(file); }
  });

  test('works correctly when N equals exact line count', async () => {
    const file = makeTempFile('x\ny\nz\n');
    try {
      expect(await lastNLines(file, 3)).toEqual(['x', 'y', 'z']);
    } finally { cleanup(file); }
  });

  // ----- trailing newline handling ------------------------------------------

  test('handles file with no trailing newline', async () => {
    const file = makeTempFile('a\nb\nc');
    try {
      expect(await lastNLines(file, 10)).toEqual(['a', 'b', 'c']);
    } finally { cleanup(file); }
  });

  // ----- blank lines --------------------------------------------------------

  test('preserves blank lines (consecutive newlines) as empty strings', async () => {
    // file: "a\n\nb\n\nc\n" → lines are ['a', '', 'b', '', 'c']
    const file = makeTempFile('a\n\nb\n\nc\n');
    try {
      expect(await lastNLines(file, 5)).toEqual(['a', '', 'b', '', 'c']);
    } finally { cleanup(file); }
  });

  test('returns blank line when file is only a single newline', async () => {
    const file = makeTempFile('\n');
    try {
      // "\n" → split gives ['', ''] → pop trailing '' → ['']
      expect(await lastNLines(file, 5)).toEqual(['']);
    } finally { cleanup(file); }
  });

  // ----- large files --------------------------------------------------------

  test('works with a 100k-line file without reading the whole file', async () => {
    const total = 100_000;
    const lines = Array.from({ length: total }, (_, i) => `line ${i + 1}`);
    const file = makeTempFile(lines.join('\n') + '\n');
    try {
      const result = await lastNLines(file, 10);
      expect(result).toHaveLength(10);
      expect(result[0]).toBe(`line ${total - 9}`);
      expect(result[9]).toBe(`line ${total}`);
    } finally { cleanup(file); }
  }, 15000);

  // ----- long lines (wider than chunk) -------------------------------------

  test('handles a line wider than chunk size (8192 > 4096 default)', async () => {
    const longLine = 'A'.repeat(8192);
    const file = makeTempFile(`line1\n${longLine}\nline3\n`);
    try {
      const result = await lastNLines(file, 3);
      expect(result).toHaveLength(3);
      expect(result[0]).toBe('line1');
      expect(result[1]).toBe(longLine);
      expect(result[2]).toBe('line3');
    } finally { cleanup(file); }
  });

  // ----- Unicode / multi-byte characters ------------------------------------

  test('handles Unicode multi-byte characters without corrupting offsets', async () => {
    // Each of these occupies more than 1 byte in UTF-8.
    const lines = ['café (4 bytes for é)', '日本語テスト (3 bytes/char)', '🔥 emoji (4 bytes)', 'plain ascii'];
    const file = makeTempFile(lines.join('\n') + '\n');
    try {
      const result = await lastNLines(file, 4);
      expect(result).toEqual(lines);
    } finally { cleanup(file); }
  });

  test('returns correct tail when earlier lines contain multi-byte chars', async () => {
    // The first 5 lines are wide; we want only the last 3.
    const wide = Array.from({ length: 5 }, (_, i) => `日本 ${i}`);
    const ascii = ['last1', 'last2', 'last3'];
    const file = makeTempFile([...wide, ...ascii].join('\n') + '\n');
    try {
      const result = await lastNLines(file, 3);
      expect(result).toEqual(ascii);
    } finally { cleanup(file); }
  });

  // ----- custom chunk size --------------------------------------------------

  test('works correctly with a very small custom chunk size (16 bytes)', async () => {
    const file = makeTempFile('short\nlines\nhere\n');
    try {
      // 16-byte chunks will require multiple reads
      const result = await lastNLines(file, 3, 16);
      expect(result).toEqual(['short', 'lines', 'here']);
    } finally { cleanup(file); }
  });

  // ----- error cases --------------------------------------------------------

  test('throws ENOENT for a non-existent file', async () => {
    await expect(lastNLines('/tmp/does-not-exist-xyz-99999', 10))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

});

// ---------------------------------------------------------------------------
// readFrom
// ---------------------------------------------------------------------------

describe('readFrom', () => {

  // ----- basic reads --------------------------------------------------------

  test('reads all complete lines from offset 0', async () => {
    const file = makeTempFile('line1\nline2\nline3\n');
    try {
      const { lines, newOffset, remainder } = await readFrom(file, 0);
      expect(lines).toEqual(['line1', 'line2', 'line3']);
      expect(remainder).toBe('');
      expect(newOffset).toBe(fs.statSync(file).size);
    } finally { cleanup(file); }
  });

  test('reads only bytes after a given mid-file offset', async () => {
    const file = makeTempFile('line1\nline2\nline3\n');
    const offset = Buffer.byteLength('line1\n');
    try {
      const { lines, newOffset } = await readFrom(file, offset);
      expect(lines).toEqual(['line2', 'line3']);
      expect(newOffset).toBe(fs.statSync(file).size);
    } finally { cleanup(file); }
  });

  test('returns no lines and same offset when file has not grown', async () => {
    const content = 'line1\nline2\n';
    const file = makeTempFile(content);
    const offset = Buffer.byteLength(content);
    try {
      const { lines, newOffset } = await readFrom(file, offset);
      expect(lines).toEqual([]);
      expect(newOffset).toBe(offset);
    } finally { cleanup(file); }
  });

  test('returns no lines and offset 0 for empty file', async () => {
    const file = makeTempFile('');
    try {
      const { lines, newOffset, remainder } = await readFrom(file, 0);
      expect(lines).toEqual([]);
      expect(newOffset).toBe(0);
      expect(remainder).toBe('');
    } finally { cleanup(file); }
  });

  // ----- partial line buffering --------------------------------------------

  test('returns partial (unterminated) content as remainder', async () => {
    const file = makeTempFile('complete\npartial');
    try {
      const { lines, remainder } = await readFrom(file, 0);
      expect(lines).toEqual(['complete']);
      expect(remainder).toBe('partial');
    } finally { cleanup(file); }
  });

  test('prepends pending remainder to the start of the next read', async () => {
    // Previous read returned remainder="partial"; file now has "_rest\nnext\n"
    const file = makeTempFile('_rest\nnext\n');
    try {
      const { lines } = await readFrom(file, 0, 'partial');
      expect(lines[0]).toBe('partial_rest');
      expect(lines[1]).toBe('next');
    } finally { cleanup(file); }
  });

  test('emits a blank line when a lone newline is appended', async () => {
    const file = makeTempFile('prev\n');
    const offset = Buffer.byteLength('prev\n');
    try {
      fs.appendFileSync(file, '\n');
      const { lines, remainder } = await readFrom(file, offset);
      expect(lines).toEqual(['']); // blank line = empty string
      expect(remainder).toBe('');
    } finally { cleanup(file); }
  });

  // ----- sequential appends (real usage simulation) ------------------------

  test('correctly reads three sequential appends building on previous offset', async () => {
    const file = makeTempFile('initial\n');
    let offset = Buffer.byteLength('initial\n');
    try {
      fs.appendFileSync(file, 'append1\n');
      const r1 = await readFrom(file, offset);
      expect(r1.lines).toEqual(['append1']);
      offset = r1.newOffset;

      fs.appendFileSync(file, 'append2\n');
      const r2 = await readFrom(file, offset);
      expect(r2.lines).toEqual(['append2']);
      offset = r2.newOffset;

      fs.appendFileSync(file, 'append3\n');
      const r3 = await readFrom(file, offset);
      expect(r3.lines).toEqual(['append3']);
    } finally { cleanup(file); }
  });

  test('buffers a partial line then completes it on next append', async () => {
    const file = makeTempFile('');
    try {
      // First write: no newline → should be buffered as remainder
      fs.appendFileSync(file, 'half');
      const r1 = await readFrom(file, 0);
      expect(r1.lines).toEqual([]);
      expect(r1.remainder).toBe('half');

      // Second write: completes the line
      fs.appendFileSync(file, '-line\n');
      const r2 = await readFrom(file, r1.newOffset, r1.remainder);
      expect(r2.lines).toEqual(['half-line']);
      expect(r2.remainder).toBe('');
    } finally { cleanup(file); }
  });

  // ----- error cases --------------------------------------------------------

  test('throws ENOENT when the file does not exist', async () => {
    await expect(readFrom('/tmp/no-such-file-xyz-99999', 0))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

});
