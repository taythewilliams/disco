/**
 * Shell budget check (D4, BUILD.md Part F).
 *
 * Thirty phones fetch this at the door over one access point, and an installed
 * iOS PWA fetches it *again* into its own storage container after install (D15).
 * A shell that grows quietly is a fifteen-second arrival window that grows
 * quietly with it, so the limit is enforced by the build rather than watched.
 *
 * Measures gzipped bytes of everything the browser needs before the app can
 * run — entry JS, its static imports, and CSS — not the whole `dist`, which
 * includes source maps and icons that are not on the critical path.
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BUDGET_BYTES = 1024 * 1024;
const DIST = new URL('../dist/', import.meta.url).pathname;

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

const files = walk(DIST).filter((path) => /\.(js|css|html)$/.test(path) && !path.endsWith('.map'));

let total = 0;
const rows = [];
for (const path of files) {
  const gzipped = gzipSync(readFileSync(path)).length;
  total += gzipped;
  rows.push([path.slice(DIST.length), gzipped]);
}

rows.sort((a, b) => b[1] - a[1]);
for (const [name, bytes] of rows) {
  process.stdout.write(`  ${(bytes / 1024).toFixed(1).padStart(8)} kB  ${name}\n`);
}

const kb = (total / 1024).toFixed(1);
const budgetKb = (BUDGET_BYTES / 1024).toFixed(0);
if (total > BUDGET_BYTES) {
  process.stderr.write(`\nShell budget exceeded: ${kb} kB gzipped, limit ${budgetKb} kB.\n`);
  process.exit(1);
}

process.stdout.write(
  `\nShell: ${kb} kB gzipped of ${budgetKb} kB budget ` +
    `(${((total / BUDGET_BYTES) * 100).toFixed(0)}% used).\n`,
);
