/**
 * A one-line progress display, written by hand rather than pulled in as a
 * dependency — it is thirty lines and the alternative is a transitive tree.
 *
 * Falls back to periodic plain lines when stdout is not a TTY, so a run piped
 * to a log file stays readable.
 */

export class Progress {
  #done = 0;
  #failed = 0;
  #lastLineLength = 0;
  readonly #startedAt = Date.now();
  readonly #tty = process.stdout.isTTY === true;

  constructor(
    readonly total: number,
    readonly label: string,
  ) {}

  tick(failed: boolean): void {
    this.#done++;
    if (failed) this.#failed++;
    this.#render();
  }

  /** Print a line above the progress display without corrupting it. */
  note(message: string): void {
    if (this.#tty) this.#clear();
    process.stdout.write(`${message}\n`);
    if (this.#tty) this.#render();
  }

  finish(): void {
    if (this.#tty) this.#clear();
    const elapsed = ((Date.now() - this.#startedAt) / 1000).toFixed(1);
    process.stdout.write(
      `${this.label}: ${this.#done}/${this.total} in ${elapsed}s` +
        (this.#failed > 0 ? `, ${this.#failed} failed\n` : '\n'),
    );
  }

  #render(): void {
    const pct = this.total === 0 ? 100 : Math.floor((this.#done / this.total) * 100);
    const line =
      `${this.label} ${bar(pct)} ${pct}%  ${this.#done}/${this.total}` +
      (this.#failed > 0 ? `  (${this.#failed} failed)` : '') +
      `  ${eta(this.#startedAt, this.#done, this.total)}`;

    if (!this.#tty) {
      // Every tenth track, so a piped log gets progress without a flood.
      if (this.#done % 10 === 0 || this.#done === this.total) process.stdout.write(`${line}\n`);
      return;
    }
    process.stdout.write(`\r${line.padEnd(this.#lastLineLength)}`);
    this.#lastLineLength = line.length;
  }

  #clear(): void {
    process.stdout.write(`\r${' '.repeat(this.#lastLineLength)}\r`);
    this.#lastLineLength = 0;
  }
}

function bar(pct: number, width = 24): string {
  const filled = Math.round((pct / 100) * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

function eta(startedAt: number, done: number, total: number): string {
  if (done === 0) return 'eta --:--';
  const perItem = (Date.now() - startedAt) / done;
  const remaining = Math.round((perItem * (total - done)) / 1000);
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  return `eta ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
