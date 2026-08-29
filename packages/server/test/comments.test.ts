import { beforeEach, describe, expect, it } from 'vitest';
import { Comments } from '../src/comments.js';
import { WordFilter, normaliseForMatching } from '../src/profanity.js';

const T0 = 1_000_000;
let comments: Comments;

beforeEach(() => {
  comments = new Comments({ filter: new WordFilter(['badword', 'worse']) });
});

describe('one pipeline, two modes', () => {
  it('holds in review mode and publishes in open mode', () => {
    // The same submission, the same validation, the same filter — only the hold
    // stage differs. That is the whole design (D7).
    expect(comments.submit('hello', T0, 'review').status).toBe('held');
    expect(comments.submit('hello', T0, 'open').status).toBe('published');
  });

  it('filters identically in both modes', () => {
    expect(comments.submit('badword', T0, 'review')).toEqual({
      status: 'rejected',
      reason: 'filtered',
    });
    expect(comments.submit('badword', T0, 'open')).toEqual({
      status: 'rejected',
      reason: 'filtered',
    });
  });

  it('sanitises before publishing', () => {
    const bidi = String.fromCodePoint(0x202e);
    const result = comments.submit(`hello${bidi} world\nsecond line`, T0, 'open');
    expect(result.status).toBe('published');
    expect(comments.published()[0]?.text).toBe('hello world second line');
  });

  it('rejects empty and over-long text', () => {
    expect(comments.submit('   ', T0, 'open')).toEqual({ status: 'rejected', reason: 'empty' });
    expect(comments.submit('a'.repeat(141), T0, 'open')).toEqual({
      status: 'rejected',
      reason: 'too-long',
    });
  });
});

describe('moderation', () => {
  it('approves a held comment onto the feed', () => {
    const held = comments.submit('play some jungle', T0, 'review');
    const id = held.status === 'held' ? held.item.id : '';
    expect(comments.approve(id)?.text).toBe('play some jungle');
    expect(comments.published().map((c) => c.text)).toEqual(['play some jungle']);
    expect(comments.pending()).toEqual([]);
  });

  it('rejects a held comment without publishing it', () => {
    const held = comments.submit('no thanks', T0, 'review');
    const id = held.status === 'held' ? held.item.id : '';
    expect(comments.reject(id)).toBe(true);
    expect(comments.published()).toEqual([]);
    expect(comments.pending()).toEqual([]);
  });

  it('removes a published comment retroactively', () => {
    // Under open mode the DJ's only recourse is retroactive, so it has to work.
    const published = comments.submit('oops', T0, 'open');
    const id = published.status === 'published' ? published.item.id : '';
    expect(comments.remove(id)).toBe(true);
    expect(comments.published()).toEqual([]);
  });

  it('reports a miss rather than throwing on an unknown id', () => {
    expect(comments.approve('nope')).toBeNull();
    expect(comments.reject('nope')).toBe(false);
    expect(comments.remove('nope')).toBe(false);
  });

  it('hides and unhides the feed', () => {
    comments.submit('visible', T0, 'open');
    comments.setHidden(true);
    expect(comments.hidden).toBe(true);
    // Hiding does not delete: unhiding brings the same feed back.
    expect(comments.published()).toHaveLength(1);
    comments.setHidden(false);
    expect(comments.hidden).toBe(false);
  });
});

describe('backlog control', () => {
  it('expires pending comments past the TTL', () => {
    comments.submit('old', T0, 'review');
    comments.submit('newer', T0 + 500_000, 'review');
    expect(comments.expirePending(T0 + 600_001, 600_000)).toBe(1);
    expect(comments.pending().map((c) => c.text)).toEqual(['newer']);
  });

  it('expires nothing when everything is fresh', () => {
    comments.submit('fresh', T0, 'review');
    expect(comments.expirePending(T0 + 1_000, 600_000)).toBe(0);
  });

  it('refuses new submissions once the pending stack is full', () => {
    for (let i = 0; i < 100; i++) comments.submit(`m${i}`, T0, 'review');
    expect(comments.submit('one more', T0, 'review')).toEqual({
      status: 'rejected',
      reason: 'backlog',
    });
  });

  it('caps the published feed, dropping the oldest', () => {
    for (let i = 0; i < 60; i++) comments.submit(`m${i}`, T0 + i, 'open');
    const published = comments.published();
    expect(published).toHaveLength(50);
    expect(published[0]?.text).toBe('m10');
    expect(published.at(-1)?.text).toBe('m59');
  });

  it('clears everything after the event', () => {
    comments.submit('published', T0, 'open');
    comments.submit('pending', T0, 'review');
    comments.clear();
    expect(comments.published()).toEqual([]);
    expect(comments.pending()).toEqual([]);
  });
});

describe('WordFilter', () => {
  it('catches the plain spelling', () => {
    const filter = new WordFilter(['badword']);
    expect(filter.blocks('this is a badword here')).toBe(true);
    expect(filter.blocks('perfectly fine')).toBe(false);
  });

  it('catches the obvious evasions and nothing cleverer', () => {
    const filter = new WordFilter(['badword']);
    expect(filter.blocks('b a d w o r d')).toBe(true);
    expect(filter.blocks('b4dw0rd')).toBe(true);
    expect(filter.blocks('B-A-D-W-O-R-D')).toBe(true);
    // Honest about the limit: an inserted letter defeats a wordlist, which is
    // why the panic control exists and this is only volume reduction (D7).
    expect(filter.blocks('badxword')).toBe(false);
  });

  it('ignores terms too short to match safely', () => {
    // A two-letter term would match inside ordinary words constantly.
    expect(new WordFilter(['ab']).size).toBe(0);
  });

  it('normalises consistently', () => {
    expect(normaliseForMatching('Sh!t-3xample $5')).toBe('shitexampless');
  });
});
