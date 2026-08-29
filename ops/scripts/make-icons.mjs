/**
 * Generate the PWA icon set.
 *
 * Draws concentric rings — a record — into raw RGB and hands them to ffmpeg,
 * which is already a hard dependency for ingest. That is cheaper than adding an
 * image library to the tree for six PNGs, and it keeps the icons reproducible:
 * the source of truth is this file, not a binary someone exported once.
 *
 *   node ops/scripts/make-icons.mjs apps/guest/public/icons
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BG = [0x0f, 0x11, 0x15];
const RING = [0x6e, 0xe7, 0xb7];
const LABEL = [0xe6, 0xe9, 0xef];

/**
 * @param size pixels
 * @param maskable Maskable icons must keep their content inside the inner 80 %,
 *   because Android crops them to whatever shape the launcher uses.
 */
function render(size, maskable) {
  const data = Buffer.alloc(size * size * 3);
  const centre = (size - 1) / 2;
  const safe = maskable ? 0.4 : 0.5;
  const outer = size * safe * 0.92;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const r = Math.sqrt(dx * dx + dy * dy);

      let colour = BG;
      if (r <= outer) {
        // Grooves: alternating rings, tighter towards the rim.
        const normalised = r / outer;
        const groove = Math.sin(normalised * Math.PI * 9);
        colour = groove > 0.35 ? RING : BG;
        // The label in the middle, and a spindle hole in the middle of that.
        if (normalised < 0.28) colour = LABEL;
        if (normalised < 0.06) colour = BG;
      }

      const offset = (y * size + x) * 3;
      data[offset] = colour[0];
      data[offset + 1] = colour[1];
      data[offset + 2] = colour[2];
    }
  }
  return data;
}

function toPng(raw, size, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${size}x${size}`, '-i', '-', outPath],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    child.stdin.end(raw);
  });
}

const outDir = process.argv[2] ?? 'apps/guest/public/icons';
mkdirSync(outDir, { recursive: true });

const targets = [
  { size: 192, maskable: false, name: 'icon-192.png' },
  { size: 512, maskable: false, name: 'icon-512.png' },
  { size: 192, maskable: true, name: 'maskable-192.png' },
  { size: 512, maskable: true, name: 'maskable-512.png' },
  // iOS ignores the manifest and reads apple-touch-icon, at 180 px.
  { size: 180, maskable: false, name: 'apple-touch-icon.png' },
];

for (const target of targets) {
  await toPng(render(target.size, target.maskable), target.size, join(outDir, target.name));
  process.stdout.write(`${target.name}\n`);
}

// A favicon so a desktop tab is not a blank square during development.
await toPng(render(64, false), 64, join(outDir, '..', 'favicon.png'));
rmSync(join(outDir, '..', 'favicon.ico'), { force: true });
process.stdout.write('favicon.png\n');
