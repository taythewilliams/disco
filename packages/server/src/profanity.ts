/**
 * The automated gate on guest comments (D7).
 *
 * Be honest about what this is. Wordlist filters are defeated trivially by
 * spacing and substitution, and they catch the lazy majority rather than anyone
 * determined. It reduces volume; it is not a guarantee, and its presence is
 * explicitly not a reason to skip the panic control.
 *
 * The built-in list is deliberately short and general. Extend it per event with
 * `DISCO_WORDLIST_FILE` — one term per line, `#` for comments — so the list
 * that matters for a given crowd is not committed to the repository.
 */

import { readFileSync } from 'node:fs';

/** A starting point, not a policy. Matching is on the normalised form below. */
const DEFAULT_TERMS = [
  'fuck',
  'shit',
  'cunt',
  'bitch',
  'bastard',
  'wanker',
  'dickhead',
  'arsehole',
  'asshole',
  'motherfucker',
];

/**
 * Common character substitutions, folded before matching so that `sh1t` and
 * `f u c k` collapse onto the same form as the plain spelling. This catches
 * the obvious evasions and nothing cleverer.
 */
const SUBSTITUTIONS: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  $: 's',
  '7': 't',
  '+': 't',
  '8': 'b',
};

/** Lowercase, fold substitutions, drop everything that is not a letter. */
export function normaliseForMatching(text: string): string {
  let out = '';
  for (const ch of text.toLowerCase()) {
    const folded = SUBSTITUTIONS[ch] ?? ch;
    if (folded >= 'a' && folded <= 'z') out += folded;
  }
  return out;
}

export class WordFilter {
  readonly #terms: string[];

  constructor(terms: readonly string[] = DEFAULT_TERMS) {
    this.#terms = terms
      .map((t) => normaliseForMatching(t))
      .filter((t) => t.length >= 3)
      .sort();
  }

  /** Load extra terms from a file, ignoring a missing one rather than failing to boot. */
  static fromFile(path: string | undefined): WordFilter {
    if (!path) return new WordFilter();
    let extra: string[] = [];
    try {
      extra = readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
    } catch {
      // An event running without its custom list is better than one that will
      // not start ten minutes before doors.
      return new WordFilter();
    }
    return new WordFilter([...DEFAULT_TERMS, ...extra]);
  }

  get size(): number {
    return this.#terms.length;
  }

  blocks(text: string): boolean {
    const normalised = normaliseForMatching(text);
    return this.#terms.some((term) => normalised.includes(term));
  }
}
