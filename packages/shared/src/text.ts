/**
 * Guest comment sanitisation (D7, D12).
 *
 * This is the system's first user-generated content and it lands on a projector
 * in front of a room, so it gets cleaned here — in shared code, so the client
 * field and the server both use exactly one implementation — and escaped again
 * on output by the renderer. Neither layer is trusted to be the only one.
 *
 * Note what this deliberately does *not* do: it is not a profanity filter and
 * not an XSS defence. Escaping on output is the XSS defence (never
 * `innerHTML`). This pass only removes characters that wreck a layout or hide
 * text from a human moderator.
 */

import { COMMENT_MAX_COMBINING_RUN, COMMENT_MAX_LENGTH } from './constants.js';

/**
 * Code-point ranges removed from guest text, written as numbers so that this
 * source file contains no invisible characters of its own — the class is built
 * at load time instead.
 */
const STRIPPED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls. Newlines included: a comment is one line.
  [0x007f, 0x009f], // DEL and the C1 controls.
  [0x061c, 0x061c], // Arabic letter mark.
  [0x200b, 0x200f], // Zero-width space/non-joiner/joiner, LRM, RLM.
  [0x202a, 0x202e], // Bidi embeddings and overrides — reverse rendering order.
  [0x2060, 0x2060], // Word joiner.
  [0x2066, 0x2069], // Bidi isolates.
  [0xfeff, 0xfeff], // BOM used mid-string as a zero-width no-break space.
];

const cp = String.fromCodePoint;

const STRIPPED = new RegExp(
  `[${STRIPPED_RANGES.map(([lo, hi]) => `${cp(lo)}-${cp(hi)}`).join('')}]`,
  'gu',
);

/** Runs of combining marks, stacked to spill text over neighbouring lines. */
const COMBINING_RUN = /\p{M}+/gu;

const WHITESPACE_RUN = /\s+/gu;

/**
 * Clean a submission. Always returns a string; the caller still has to decide
 * whether what is left is acceptable — see `validateCommentText`.
 */
export function sanitiseCommentText(raw: string): string {
  return (
    raw
      // NFC first: composing marks into precomposed characters shortens most
      // legitimate accented text before the anti-stacking cap sees it.
      .normalize('NFC')
      // Whitespace collapses before controls are stripped, so a newline becomes
      // a word separator rather than glue: "one\ntwo" must not read "onetwo".
      .replace(WHITESPACE_RUN, ' ')
      .replace(STRIPPED, '')
      .replace(COMBINING_RUN, (run) => [...run].slice(0, COMMENT_MAX_COMBINING_RUN).join(''))
      // Again, because removing a control character can leave a gap behind.
      .replace(WHITESPACE_RUN, ' ')
      .trim()
  );
}

export type CommentValidation =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'too-long' };

/**
 * Sanitise then length-check, in code points rather than UTF-16 units so a
 * string of astral characters cannot smuggle twice the visible length past a
 * `.length` check.
 */
export function validateCommentText(
  raw: string,
  maxLength: number = COMMENT_MAX_LENGTH,
): CommentValidation {
  const text = sanitiseCommentText(raw);
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if ([...text].length > maxLength) return { ok: false, reason: 'too-long' };
  return { ok: true, text };
}
