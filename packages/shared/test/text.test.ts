import { describe, expect, it } from 'vitest';
import { sanitiseCommentText, validateCommentText } from '../src/text.js';

/** Built from code points so the test file itself stays readable and greppable. */
const ch = (code: number) => String.fromCodePoint(code);
const RLO = ch(0x202e); // right-to-left override
const LRI = ch(0x2066); // left-to-right isolate
const ZWSP = ch(0x200b);
const ZWJ = ch(0x200d);
const BOM = ch(0xfeff);
const NUL = ch(0x0000);
const BELL = ch(0x0007);
const COMBINING_ACUTE = ch(0x0301);

describe('sanitiseCommentText', () => {
  it('leaves ordinary text alone', () => {
    expect(sanitiseCommentText('play some drum and bass!')).toBe('play some drum and bass!');
  });

  it('keeps accents, emoji and non-Latin scripts', () => {
    expect(sanitiseCommentText('café 🎧 привет こんにちは')).toBe('café 🎧 привет こんにちは');
  });

  it('strips control characters', () => {
    expect(sanitiseCommentText(`hel${NUL}lo${BELL}`)).toBe('hello');
  });

  it('collapses newlines and tabs into single spaces', () => {
    // A comment is one line on a projector; a multi-line one shoves the rest off.
    expect(sanitiseCommentText('one\n\n\ttwo   three')).toBe('one two three');
  });

  it('strips bidi overrides and isolates', () => {
    // The classic trick: text that renders in the reverse of the order a
    // moderator reads it in.
    expect(sanitiseCommentText(`hello ${RLO}dlrow${LRI}`)).toBe('hello dlrow');
  });

  it('strips zero-width characters used to break up filtered words', () => {
    expect(sanitiseCommentText(`b${ZWSP}a${ZWJ}d${BOM}`)).toBe('bad');
  });

  it('caps stacked combining marks', () => {
    // Zalgo: enough marks and the text climbs over neighbouring lines.
    const zalgo = 'a' + COMBINING_ACUTE.repeat(40);
    const out = sanitiseCommentText(zalgo);
    expect([...out].length).toBeLessThanOrEqual(3);
  });

  it('composes before capping, so a normal accent survives', () => {
    // "e" + combining acute normalises to a single precomposed character, and
    // never reaches the combining-mark cap at all.
    expect(sanitiseCommentText(`caf${'e' + COMBINING_ACUTE}`)).toBe('café');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitiseCommentText('   spaced   ')).toBe('spaced');
  });
});

describe('validateCommentText', () => {
  it('accepts a normal submission', () => {
    expect(validateCommentText('more cowbell')).toEqual({ ok: true, text: 'more cowbell' });
  });

  it('rejects text that is empty once cleaned', () => {
    expect(validateCommentText('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateCommentText(`  ${ZWSP}${BOM} `)).toEqual({ ok: false, reason: 'empty' });
  });

  it('enforces the cap at exactly 140', () => {
    expect(validateCommentText('a'.repeat(140)).ok).toBe(true);
    expect(validateCommentText('a'.repeat(141))).toEqual({ ok: false, reason: 'too-long' });
  });

  it('counts code points, not UTF-16 units', () => {
    // 100 astral characters are 200 units. A `.length` check would reject them
    // and a naive cap would let twice the visible text onto the projector.
    expect(validateCommentText('🎶'.repeat(100)).ok).toBe(true);
    expect(validateCommentText('🎶'.repeat(141)).ok).toBe(false);
  });

  it('honours a caller-supplied cap', () => {
    expect(validateCommentText('abcdef', 5)).toEqual({ ok: false, reason: 'too-long' });
  });
});
