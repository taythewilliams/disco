/**
 * The comment pipeline (D7).
 *
 * One code path, both modes. Every submission runs validate → filter → hold or
 * promote → render, and the moderation mode is a boolean on the hold stage
 * rather than a second implementation. That is the whole design: the two modes
 * cannot drift apart because there is only one of them.
 *
 * Everything here is in memory and dies with the process. Comments are
 * ephemeral by decision, not by accident — nothing writes them to the manifest,
 * and nothing logs them.
 */

import { randomBytes } from 'node:crypto';
import { validateCommentText, type FeedItem, type ModerationMode } from '@disco/shared';
import type { WordFilter } from './profanity.js';

/** Newest-first, capped: the projector shows a handful and the dashboard scrolls. */
const MAX_PUBLISHED = 50;
const MAX_PENDING = 100;

export type SubmitResult =
  | { status: 'published'; item: FeedItem }
  | { status: 'held'; item: FeedItem }
  | { status: 'rejected'; reason: 'empty' | 'too-long' | 'filtered' | 'backlog' };

export interface CommentsDeps {
  filter: WordFilter;
}

export class Comments {
  /** Cleared for the projector, newest last. */
  #published: FeedItem[] = [];
  /** Waiting on the DJ in review mode. */
  #pending: FeedItem[] = [];
  #hidden = false;

  constructor(private readonly deps: CommentsDeps) {}

  get hidden(): boolean {
    return this.#hidden;
  }

  /** The panic control. Hides the feed; visuals and now-playing stay up (D7). */
  setHidden(hidden: boolean): void {
    this.#hidden = hidden;
  }

  published(): FeedItem[] {
    return [...this.#published];
  }

  pending(): FeedItem[] {
    return [...this.#pending];
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  submit(rawText: string, now: number, mode: ModerationMode): SubmitResult {
    // Validation and the length cap are enforced here as well as in the field:
    // the field is a courtesy, this is the check (D7).
    const validation = validateCommentText(rawText);
    if (!validation.ok) return { status: 'rejected', reason: validation.reason };

    if (this.deps.filter.blocks(validation.text)) {
      return { status: 'rejected', reason: 'filtered' };
    }

    const item: FeedItem = { id: newCommentId(), text: validation.text, at: now };

    if (mode === 'open') {
      this.#publish(item);
      return { status: 'published', item };
    }

    if (this.#pending.length >= MAX_PENDING) {
      // A backlog nobody will ever clear is worse than a refusal the guest can
      // see and retry.
      return { status: 'rejected', reason: 'backlog' };
    }
    this.#pending.push(item);
    return { status: 'held', item };
  }

  approve(id: string): FeedItem | null {
    const index = this.#pending.findIndex((c) => c.id === id);
    if (index === -1) return null;
    const [item] = this.#pending.splice(index, 1);
    if (!item) return null;
    this.#publish(item);
    return item;
  }

  reject(id: string): boolean {
    const index = this.#pending.findIndex((c) => c.id === id);
    if (index === -1) return false;
    this.#pending.splice(index, 1);
    return true;
  }

  /** Retroactive removal — the recourse that matters in open mode. */
  remove(id: string): boolean {
    const index = this.#published.findIndex((c) => c.id === id);
    if (index === -1) return false;
    this.#published.splice(index, 1);
    return true;
  }

  /**
   * Drop pending items older than the expiry.
   *
   * Without this, a busy twenty minutes produces forty stale comments and the
   * DJ faces a wall of context-free text from three tracks ago. Expiring
   * quietly beats a backlog nobody will clear (D7).
   */
  expirePending(now: number, ttlMs: number): number {
    const cutoff = now - ttlMs;
    const before = this.#pending.length;
    this.#pending = this.#pending.filter((c) => c.at >= cutoff);
    return before - this.#pending.length;
  }

  /** After the event. Comments are not kept (D7, D12). */
  clear(): void {
    this.#published = [];
    this.#pending = [];
  }

  #publish(item: FeedItem): void {
    this.#published.push(item);
    if (this.#published.length > MAX_PUBLISHED) {
      this.#published.splice(0, this.#published.length - MAX_PUBLISHED);
    }
  }
}

function newCommentId(): string {
  return randomBytes(6).toString('hex');
}
