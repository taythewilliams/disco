/**
 * Platform integrations: Wake Lock, Media Session, install prompts (D15, D16).
 *
 * Every one of these is a layered mitigation for the same thing — the phone
 * going to sleep or the OS suspending audio — and every one of them is optional
 * on some platform. Nothing here throws upward: a missing API is a slightly
 * worse night, not a broken app.
 */

// ─── Wake Lock ──────────────────────────────────────────────────────────────

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', handler: () => void): void;
}

/**
 * Keeps the screen awake while music plays.
 *
 * Re-acquires on visibility change, because the browser releases the lock
 * whenever the page is hidden and does not give it back on its own. Without the
 * re-acquire the lock silently stops working the first time a guest checks a
 * message, which is the exact moment it stops working in testing too.
 */
export class ScreenWakeLock {
  #sentinel: WakeLockSentinelLike | null = null;
  #wanted = false;
  #onVisibility: (() => void) | null = null;

  get held(): boolean {
    return this.#sentinel !== null;
  }

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  async acquire(): Promise<void> {
    this.#wanted = true;
    await this.#request();

    if (!this.#onVisibility && typeof document !== 'undefined') {
      this.#onVisibility = () => {
        if (this.#wanted && document.visibilityState === 'visible') void this.#request();
      };
      document.addEventListener('visibilitychange', this.#onVisibility);
    }
  }

  async release(): Promise<void> {
    this.#wanted = false;
    if (this.#onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibility);
      this.#onVisibility = null;
    }
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    if (sentinel) await sentinel.release().catch(() => {});
  }

  async #request(): Promise<void> {
    if (this.#sentinel || !this.supported) return;
    try {
      const wakeLock = (navigator as unknown as {
        wakeLock: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
      }).wakeLock;
      const sentinel = await wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        this.#sentinel = null;
      });
      this.#sentinel = sentinel;
    } catch {
      // Denied, or the page is not visible. Battery saver refuses it outright
      // on some devices; that is the guest's phone making a reasonable choice.
    }
  }
}

// ─── Media Session ──────────────────────────────────────────────────────────

export interface NowPlaying {
  title: string;
  artist: string;
  artUrl: string | null;
}

/**
 * Lock-screen metadata and controls.
 *
 * Worth having even though the guest cannot change the track: the lock screen
 * showing what is playing is what stops iOS treating the tab as idle, and it is
 * the difference between a pocketed phone that keeps playing and one that does
 * not (D16).
 *
 * The transport actions are deliberately *not* wired to anything that mutates
 * the room. A guest pressing pause on their lock screen pauses their own audio,
 * not everybody's.
 */
export function setMediaSession(nowPlaying: NowPlaying | null, handlers: {
  onPause?: () => void;
  onPlay?: () => void;
}): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const session = (navigator as Navigator & { mediaSession: MediaSession }).mediaSession;

  if (!nowPlaying) {
    session.metadata = null;
    session.playbackState = 'none';
    return;
  }

  try {
    session.metadata = new MediaMetadata({
      title: nowPlaying.title,
      artist: nowPlaying.artist,
      album: 'Disco',
      artwork: nowPlaying.artUrl
        ? [{ src: nowPlaying.artUrl, sizes: '512x512', type: 'image/jpeg' }]
        : [],
    });
    session.playbackState = 'playing';
    if (handlers.onPause) session.setActionHandler('pause', handlers.onPause);
    if (handlers.onPlay) session.setActionHandler('play', handlers.onPlay);
    // Nothing here should look like it can steer the room.
    session.setActionHandler('previoustrack', null);
    session.setActionHandler('nexttrack', null);
    session.setActionHandler('seekto', null);
  } catch {
    // `MediaMetadata` is missing on older WebKit. Nothing else depends on it.
  }
}

// ─── Install ────────────────────────────────────────────────────────────────

export type InstallState = 'installed' | 'available' | 'ios-manual' | 'unavailable';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Install prompting, which is two entirely different things by platform (D15).
 *
 * Android fires `beforeinstallprompt` and gives a real button. iOS does not:
 * the guest has to go through the share sheet by hand, so all we can do is
 * detect the situation and show a clear illustrated walkthrough.
 */
export class InstallPrompt {
  #deferred: BeforeInstallPromptEvent | null = null;
  #onChange: (() => void) | null = null;

  constructor(private readonly scope: Window = window) {}

  listen(onChange: () => void): () => void {
    this.#onChange = onChange;
    const handler = (event: Event) => {
      // Suppress the browser's own mini-infobar so the prompt appears where the
      // arrival flow wants it, not over the calibration slider.
      event.preventDefault();
      this.#deferred = event as BeforeInstallPromptEvent;
      onChange();
    };
    const installed = () => {
      this.#deferred = null;
      onChange();
    };

    this.scope.addEventListener('beforeinstallprompt', handler);
    this.scope.addEventListener('appinstalled', installed);
    return () => {
      this.scope.removeEventListener('beforeinstallprompt', handler);
      this.scope.removeEventListener('appinstalled', installed);
      this.#onChange = null;
    };
  }

  get state(): InstallState {
    if (isStandalone(this.scope)) return 'installed';
    if (this.#deferred) return 'available';
    if (isIOS(this.scope)) return 'ios-manual';
    return 'unavailable';
  }

  /** Returns true if the guest accepted. Only meaningful when state is `available`. */
  async prompt(): Promise<boolean> {
    const deferred = this.#deferred;
    if (!deferred) return false;
    this.#deferred = null;
    this.#onChange?.();
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      return outcome === 'accepted';
    } catch {
      return false;
    }
  }
}

/** Already running as an installed app, by either platform's signal. */
export function isStandalone(scope: Window = window): boolean {
  const iosStandalone = (scope.navigator as Navigator & { standalone?: boolean }).standalone;
  return (
    iosStandalone === true ||
    scope.matchMedia?.('(display-mode: standalone)').matches === true
  );
}

export function isIOS(scope: Window = window): boolean {
  const ua = scope.navigator.userAgent;
  // iPadOS reports a desktop user agent, so the touch-point check catches it.
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && (scope.navigator.maxTouchPoints ?? 0) > 1)
  );
}
