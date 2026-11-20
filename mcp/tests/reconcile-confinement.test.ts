// reconcile_statement path confinement, against a real filesystem (the
// sibling reconcile-tool.test.ts mocks node:fs, which can't model symlinks).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPdfBase64 } from '../src/tools.js';

let root: string;
let dir: string;
const BYTES = Buffer.from('%PDF-1.4 confinement');

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hoopoe-mcp-'));
  dir = join(root, 'statements');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'april.pdf'), BYTES);
  writeFileSync(join(dir, 'sub', 'may.pdf'), BYTES);
  writeFileSync(join(root, 'secret.pdf'), BYTES);
  symlinkSync(join(root, 'secret.pdf'), join(dir, 'link.pdf'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('readPdfBase64 with HOOPOE_STATEMENTS_DIR', () => {
  it('reads files inside the directory, relative or absolute', () => {
    const b64 = BYTES.toString('base64');
    expect(readPdfBase64('april.pdf', dir)).toBe(b64);
    expect(readPdfBase64('sub/may.pdf', dir)).toBe(b64);
    expect(readPdfBase64(join(dir, 'april.pdf'), dir)).toBe(b64);
  });

  it('refuses ../ escapes', () => {
    expect(() => readPdfBase64('../secret.pdf', dir)).toThrow(/outside HOOPOE_STATEMENTS_DIR/);
  });

  it('refuses absolute paths outside the directory', () => {
    expect(() => readPdfBase64(join(root, 'secret.pdf'), dir)).toThrow(/outside HOOPOE_STATEMENTS_DIR/);
  });

  it('refuses a symlink inside the directory that points outside', () => {
    expect(() => readPdfBase64('link.pdf', dir)).toThrow(/outside HOOPOE_STATEMENTS_DIR/);
  });

  it('answers the same for missing and existing files outside', () => {
    expect(() => readPdfBase64(join(root, 'nope.pdf'), dir)).toThrow(/outside HOOPOE_STATEMENTS_DIR/);
  });

  it('still reports a missing file inside with the list of PDFs', () => {
    expect(() => readPdfBase64('june.pdf', dir)).toThrow(/not found.*april\.pdf/);
  });
});
