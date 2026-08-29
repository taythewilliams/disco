import { describe, expect, it, vi } from 'vitest';
import { InstallPrompt, isIOS, isStandalone } from '../src/platform.js';

/** A window narrowed to what the install logic actually reads. */
function fakeWindow(options: {
  userAgent?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  displayMode?: boolean;
} = {}) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    navigator: {
      userAgent: options.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64)',
      maxTouchPoints: options.maxTouchPoints ?? 0,
      ...(options.standalone === undefined ? {} : { standalone: options.standalone }),
    },
    matchMedia: () => ({ matches: options.displayMode === true }),
    addEventListener(type: string, handler: (event: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(handler);
    },
    removeEventListener(type: string, handler: (event: Event) => void) {
      listeners.get(type)?.delete(handler);
    },
    fire(type: string, event: Partial<Event> & Record<string, unknown>) {
      for (const handler of listeners.get(type) ?? []) handler(event as Event);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120';

describe('isIOS', () => {
  it('detects an iPhone', () => {
    expect(isIOS(fakeWindow({ userAgent: IPHONE }) as unknown as Window)).toBe(true);
  });

  it('detects an iPad despite its desktop user agent', () => {
    // iPadOS reports as a Mac. Touch points are what give it away, and getting
    // this wrong means iPad guests never see the share-sheet walkthrough (D15).
    expect(
      isIOS(fakeWindow({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 }) as unknown as Window),
    ).toBe(true);
  });

  it('does not mistake a real Mac for an iPad', () => {
    expect(
      isIOS(fakeWindow({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0 }) as unknown as Window),
    ).toBe(false);
  });

  it('does not mistake Android for iOS', () => {
    expect(isIOS(fakeWindow({ userAgent: ANDROID }) as unknown as Window)).toBe(false);
  });
});

describe('isStandalone', () => {
  it('reads the iOS signal', () => {
    expect(isStandalone(fakeWindow({ standalone: true }) as unknown as Window)).toBe(true);
  });

  it('reads the standards signal', () => {
    expect(isStandalone(fakeWindow({ displayMode: true }) as unknown as Window)).toBe(true);
  });

  it('is false in a plain browser tab', () => {
    expect(isStandalone(fakeWindow() as unknown as Window)).toBe(false);
  });
});

describe('InstallPrompt', () => {
  it('reports nothing to offer on a desktop browser', () => {
    const scope = fakeWindow({ userAgent: ANDROID });
    const prompt = new InstallPrompt(scope as unknown as Window);
    prompt.listen(() => {});
    expect(prompt.state).toBe('unavailable');
  });

  it('offers a real button once Android fires the event', () => {
    const scope = fakeWindow({ userAgent: ANDROID });
    const prompt = new InstallPrompt(scope as unknown as Window);
    const onChange = vi.fn();
    prompt.listen(onChange);

    const preventDefault = vi.fn();
    scope.fire('beforeinstallprompt', {
      preventDefault,
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });

    // Suppressing the browser's mini-infobar matters: left alone it appears
    // over the calibration slider, which is the one screen that needs focus.
    expect(preventDefault).toHaveBeenCalled();
    expect(prompt.state).toBe('available');
    expect(onChange).toHaveBeenCalled();
  });

  it('falls back to the manual walkthrough on iOS, which has no event', () => {
    const scope = fakeWindow({ userAgent: IPHONE });
    const prompt = new InstallPrompt(scope as unknown as Window);
    prompt.listen(() => {});
    expect(prompt.state).toBe('ios-manual');
  });

  it('reports installed and offers nothing further', () => {
    const scope = fakeWindow({ userAgent: IPHONE, standalone: true });
    const prompt = new InstallPrompt(scope as unknown as Window);
    prompt.listen(() => {});
    expect(prompt.state).toBe('installed');
  });

  it('returns the outcome and does not offer twice', async () => {
    const scope = fakeWindow({ userAgent: ANDROID });
    const prompt = new InstallPrompt(scope as unknown as Window);
    prompt.listen(() => {});
    scope.fire('beforeinstallprompt', {
      preventDefault: () => {},
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });

    expect(await prompt.prompt()).toBe(true);
    // The event is single-use; a second call must not throw or silently hang.
    expect(await prompt.prompt()).toBe(false);
    expect(prompt.state).toBe('unavailable');
  });

  it('reports a dismissal honestly', async () => {
    const scope = fakeWindow({ userAgent: ANDROID });
    const prompt = new InstallPrompt(scope as unknown as Window);
    prompt.listen(() => {});
    scope.fire('beforeinstallprompt', {
      preventDefault: () => {},
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    });
    expect(await prompt.prompt()).toBe(false);
  });

  it('clears the offer once the app is installed', () => {
    const scope = fakeWindow({ userAgent: ANDROID });
    const prompt = new InstallPrompt(scope as unknown as Window);
    prompt.listen(() => {});
    scope.fire('beforeinstallprompt', { preventDefault: () => {} });
    expect(prompt.state).toBe('available');

    scope.fire('appinstalled', {});
    expect(prompt.state).toBe('unavailable');
  });

  it('removes its listeners when told to', () => {
    const scope = fakeWindow({ userAgent: ANDROID });
    const prompt = new InstallPrompt(scope as unknown as Window);
    const stop = prompt.listen(() => {});
    expect(scope.listenerCount('beforeinstallprompt')).toBe(1);
    stop();
    expect(scope.listenerCount('beforeinstallprompt')).toBe(0);
  });
});
