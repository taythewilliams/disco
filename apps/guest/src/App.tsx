/**
 * The guest app (D4).
 *
 * One screen at a time, because a guest at a party has one hand and no
 * patience. The whole arrival is: tap to join → calibrate while audio downloads
 * behind you → you are in the room. The guest is never in silence, because the
 * calibration loop is synthesised locally and starts immediately.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { arrivalPhase, phaseHeadline, showsReconnecting } from './arrival.js';
import {
  CALIBRATION_MAX_MS,
  CALIBRATION_MIN_MS,
  CALIBRATION_STEP_MS,
  clearCalibration,
  loadCalibration,
  quantiseCalibration,
  resolveCalibration,
  saveCalibration,
  shouldSuggestRecalibration,
  type Calibration,
} from './calibration.js';
import { CalibrationLoopPlayer } from './calibrationLoop.js';
import { InstallPrompt, ScreenWakeLock, setMediaSession, type InstallState } from './platform.js';
import { useGuest } from './useGuest.js';

/** Device classes offered in the preset step. Values come from the server (D11). */
const PRESET_CHOICES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'wired', label: 'Wired', hint: 'Cable into the phone' },
  { key: 'airpods', label: 'AirPods', hint: 'Or Beats' },
  { key: 'bluetooth', label: 'Bluetooth', hint: 'Anything else wireless' },
  { key: 'bluetooth-lowlatency', label: 'Gaming', hint: 'Low-latency wireless' },
];

export function App() {
  const [joined, setJoined] = useState(false);
  const [joinFailed, setJoinFailed] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibration, setCalibration] = useState<Calibration | null>(() =>
    loadCalibration(safeStorage()),
  );

  const guest = useGuest(joined);
  const wakeLock = useRef(new ScreenWakeLock());
  const install = useRef(new InstallPrompt());
  const [installState, setInstallState] = useState<InstallState>('unavailable');

  useEffect(() => install.current.listen(() => setInstallState(install.current.state)), []);
  useEffect(() => setInstallState(install.current.state), []);

  // Apply the calibration to the runtime whenever it changes. Everything else
  // in the client schedules against it.
  useEffect(() => {
    guest.setCalibrationMs(calibration?.offsetMs ?? 0);
  }, [calibration, guest]);

  // A refused session cannot be retried out of — send the guest back to the
  // door rather than leaving them watching a spinner.
  useEffect(() => {
    if (guest.status === 'unauthorised') {
      setJoined(false);
      setJoinFailed(true);
    }
  }, [guest.status]);

  const calibrated = calibration !== null && !calibrating;

  const phase = arrivalPhase({
    joined,
    joinFailed,
    calibrated,
    haveState: guest.state !== null,
    channelPlaying: guest.state?.trackId !== null && guest.state?.paused === false,
    channelPaused: guest.state?.paused === true,
    audioReady: guest.audioReady,
    connectionLost: guest.status === 'reconnecting',
  });

  const join = useCallback(
    async (code: string) => {
      setJoinFailed(false);
      try {
        const response = await fetch('/api/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ code }),
        });
        if (!response.ok) {
          setJoinFailed(true);
          return;
        }
        setJoined(true);
        // The join tap is the user gesture every browser demands before audio
        // will play. Spending it here is what lets calibration begin with sound
        // immediately afterwards (D4).
        await guest.resume();
        void wakeLock.current.acquire();
        if (shouldSuggestRecalibration(calibration, Date.now())) setCalibrating(true);
      } catch {
        setJoinFailed(true);
      }
    },
    [guest, calibration],
  );

  const commitCalibration = useCallback((next: Calibration) => {
    saveCalibration(safeStorage(), next);
    setCalibration(next);
    setCalibrating(false);
  }, []);

  if (!joined) {
    return (
      <Join
        onJoin={join}
        failed={joinFailed}
        // Server-driven, so wording can be fixed mid-event without a redeploy
        // (D11) — including the case where the code on the poster is wrong.
        failedMessage={phaseHeadline('join-failed', null, guest.config.strings)}
        installState={installState}
        install={install.current}
      />
    );
  }

  if (calibrating || calibration === null) {
    return (
      <Calibrate
        context={guest.context}
        presets={guest.config.devicePresetMs}
        stored={calibration}
        onDone={commitCalibration}
      />
    );
  }

  return (
    <Player
      guest={guest}
      phase={phase}
      calibration={calibration}
      onRecalibrate={() => setCalibrating(true)}
      onForget={() => {
        clearCalibration(safeStorage());
        setCalibration(null);
        setCalibrating(true);
      }}
    />
  );
}

// ─── Join ───────────────────────────────────────────────────────────────────

function Join({
  onJoin,
  failed,
  failedMessage,
  installState,
  install,
}: {
  onJoin(code: string): Promise<void>;
  failed: boolean;
  failedMessage: string;
  installState: InstallState;
  install: InstallPrompt;
}) {
  // The QR carries the code, so the field is usually already filled and the
  // guest just taps once.
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('c') ?? '');
  const [busy, setBusy] = useState(false);

  return (
    <main className="screen join">
      <h1>Disco</h1>
      <p className="lede">Headphones on. Everyone hears the same thing at the same moment.</p>

      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          await onJoin(code);
          setBusy(false);
        }}
      >
        <label htmlFor="code">Event code</label>
        <input
          id="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoCapitalize="characters"
          autoComplete="off"
          enterKeyHint="go"
        />
        <button className="primary" type="submit" disabled={busy || code.length === 0}>
          {busy ? 'Joining…' : 'Join'}
        </button>
        {failed && <p className="error">{failedMessage}</p>}
      </form>

      <InstallHint state={installState} install={install} />
    </main>
  );
}

/**
 * Install prompting, which is two different things by platform (D15).
 *
 * Android gets a button. iOS gets a walkthrough, because there is no API — and
 * an installed iOS PWA re-fetches the shell into its own storage container, so
 * the shell being small is what makes this cheap to suggest.
 */
function InstallHint({ state, install }: { state: InstallState; install: InstallPrompt }) {
  if (state === 'installed') return null;

  if (state === 'available') {
    return (
      <button className="ghost" onClick={() => void install.prompt()}>
        Add to home screen
      </button>
    );
  }

  if (state === 'ios-manual') {
    return (
      <details className="ios-install">
        <summary>Add to home screen</summary>
        <ol>
          <li>
            {/* Described rather than drawn: an SF Symbols glyph is a
                private-use code point and renders as tofu anywhere it is not
                the platform's own font. */}
            Tap the <strong>Share</strong> button — the square with an arrow
            coming out of it, at the bottom of Safari.
          </li>
          <li>Scroll and tap <strong>Add to Home Screen</strong>.</li>
          <li>Open Disco from your home screen.</li>
        </ol>
        <p className="muted">It works in Safari too — the app just stays out of your way.</p>
      </details>
    );
  }

  return null;
}

// ─── Calibrate ──────────────────────────────────────────────────────────────

/**
 * Layer 2 then layer 3 (D1): pick a device class, then refine by ear.
 *
 * The instructions are fixed wording on purpose. A method that varies between
 * guests produces variance in the answer, and variance is the thing this whole
 * screen exists to minimise (v4 Part 0).
 */
function Calibrate({
  context,
  presets,
  stored,
  onDone,
}: {
  context: AudioContext | null;
  presets: Record<string, number>;
  stored: Calibration | null;
  onDone(calibration: Calibration): void;
}) {
  const [presetKey, setPresetKey] = useState<string | null>(stored?.presetKey ?? null);
  const [offsetMs, setOffsetMs] = useState(stored?.offsetMs ?? 100);
  const [step, setStep] = useState<'device' | 'refine'>(stored ? 'refine' : 'device');
  const playerRef = useRef<CalibrationLoopPlayer | null>(null);
  const [pulse, setPulse] = useState(0);

  // Seed from the device class the moment it is chosen.
  const choosePreset = (key: string) => {
    setPresetKey(key);
    const seeded = resolveCalibration({
      stored: null,
      outputLatencySec: context?.outputLatency,
      presetKey: key,
      presets,
      now: Date.now(),
    });
    setOffsetMs(seeded.offsetMs);
    setStep('refine');
  };

  useEffect(() => {
    if (step !== 'refine' || !context) return;
    const player = new CalibrationLoopPlayer(context);
    playerRef.current = player;
    player.setOffsetMs(offsetMs);
    player.start();

    // The pulse is driven off the audio clock via rAF, not a timer: a timer
    // would drift against the audio and the guest would be aligning to a moving
    // target.
    let frame = 0;
    const draw = () => {
      const current = player.pulse();
      setPulse(current ? 1 - current.phase : 0);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      player.dispose();
      playerRef.current = null;
    };
    // `offsetMs` deliberately absent: restarting the loop on every slider move
    // would make it stutter. It is pushed in below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, context]);

  useEffect(() => {
    playerRef.current?.setOffsetMs(offsetMs);
  }, [offsetMs]);

  if (step === 'device') {
    return (
      <main className="screen calibrate">
        <h1>What are you listening on?</h1>
        <p className="lede">This gets you close. You’ll fine-tune it next.</p>
        <div className="presets">
          {PRESET_CHOICES.map((choice) => (
            <button key={choice.key} className="preset" onClick={() => choosePreset(choice.key)}>
              <strong>{choice.label}</strong>
              <span>{choice.hint}</span>
            </button>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="screen calibrate">
      <h1>Line up the beat</h1>
      {/* Identical wording for everyone. Different instructions produce
          different answers, and the spread between guests is what matters. */}
      <p className="lede">
        Drag the slider until the <strong>thump</strong> lands exactly on the flash.
      </p>

      <div className="pulse-stage" aria-hidden="true">
        <div className="pulse" style={{ transform: `scale(${0.55 + pulse * 0.45})`, opacity: 0.25 + pulse * 0.75 }} />
      </div>

      <input
        className="calibration-slider"
        type="range"
        min={CALIBRATION_MIN_MS}
        max={CALIBRATION_MAX_MS}
        step={CALIBRATION_STEP_MS}
        value={offsetMs}
        onChange={(e) => setOffsetMs(quantiseCalibration(Number(e.target.value)))}
        aria-label="Audio delay"
      />
      <p className="reading">{offsetMs} ms</p>

      <button
        className="primary"
        onClick={() =>
          onDone({
            offsetMs: quantiseCalibration(offsetMs),
            source: 'user',
            presetKey,
            at: Date.now(),
          })
        }
      >
        That’s it
      </button>
      <button className="ghost" onClick={() => setStep('device')}>
        Change device
      </button>
    </main>
  );
}

// ─── Player ─────────────────────────────────────────────────────────────────

function Player({
  guest,
  phase,
  calibration,
  onRecalibrate,
  onForget,
}: {
  guest: ReturnType<typeof useGuest>;
  phase: ReturnType<typeof arrivalPhase>;
  calibration: Calibration;
  onRecalibrate(): void;
  onForget(): void;
}) {
  const [volume, setVolume] = useState(1);
  const [comment, setComment] = useState('');
  const [commentSentAt, setCommentSentAt] = useState(0);

  const track = guest.state?.trackId ? guest.tracks.get(guest.state.trackId) : undefined;
  const reconnecting = showsReconnecting(phase, guest.status === 'reconnecting');

  useEffect(() => {
    guest.setVolume(volume);
  }, [volume, guest]);

  useEffect(() => {
    setMediaSession(
      track ? { title: track.title, artist: track.artist, artUrl: track.artUrl } : null,
      {},
    );
  }, [track]);

  // Client-side rate limit, mirroring the server's. The server enforces the
  // real one; this just stops the button feeling broken (D7).
  const perMinute = guest.config.commentsPerMinute;
  const cooldownMs = perMinute > 0 ? 60_000 / perMinute : 60_000;
  const canComment = Date.now() - commentSentAt > cooldownMs;

  const remaining = useMemo(() => 140 - [...comment].length, [comment]);

  return (
    <main className="screen player">
      <header className="now">
        <p className="phase">
          {phaseHeadline(phase, guest.catchUpSec, guest.config.strings)}
          {reconnecting && <span className="reconnecting"> · reconnecting</span>}
        </p>
        {track ? (
          <>
            <h1>{track.title}</h1>
            <p className="artist">{track.artist}</p>
          </>
        ) : (
          <h1 className="muted">—</h1>
        )}
      </header>

      <label className="volume">
        Volume
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
      </label>

      <form
        className="comment"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canComment || comment.trim().length === 0) return;
          guest.sendComment(comment);
          setComment('');
          setCommentSentAt(Date.now());
        }}
      >
        <label htmlFor="comment">Say something</label>
        <textarea
          id="comment"
          value={comment}
          maxLength={140}
          rows={2}
          placeholder="Song request, shout-out, anything"
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="comment-row">
          <span className={remaining < 20 ? 'count low' : 'count'}>{remaining}</span>
          <button className="primary" type="submit" disabled={!canComment || comment.trim() === ''}>
            {canComment ? 'Send' : 'Hold on…'}
          </button>
        </div>
        {guest.lastError && <p className="error">{guest.lastError}</p>}
      </form>

      {/* A guest cannot fix a bug but can absolutely delete some photos. */}
      {guest.storageFull && (
        <p className="error">
          {guest.config.strings['storageFull'] ??
            'Your phone is out of space. Free some up and reload.'}
        </p>
      )}

      {/* Permanently visible, never behind a menu. Swapping headphones moves
          latency by ~200 ms and there is no reliable way to detect it (D1). */}
      <footer className="tuning">
        <button className="ghost" onClick={onRecalibrate}>
          Re-tune ({calibration.offsetMs} ms)
        </button>
        <button className="ghost quiet" onClick={onForget}>
          Start over
        </button>
      </footer>
    </main>
  );
}

/** localStorage, or a no-op if the browser refuses it (Safari private mode). */
function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
}
