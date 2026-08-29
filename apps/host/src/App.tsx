/**
 * The host app: the DJ dashboard at `/dj`, the projector at `/display`.
 *
 * One app with two routes because both run on the trusted network, on machines
 * you control, and share the channel-colour and now-playing vocabulary. The
 * guest PWA stays a separate build specifically so this app's weight — tables,
 * search, config — can never leak into the shell thirty phones fetch at the
 * door (BUILD.md Part B).
 *
 * Guest text is rendered as React children throughout — never `innerHTML` —
 * because this app owns both screens a guest submission reaches (D7, OWASP
 * A03).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CHANNEL_ID,
  MODERATION_MODES,
  ENGINE_OVERRIDES,
  type Role,
  type StateMsg,
} from '@disco/shared';
import {
  currentRole,
  fetchLibrary,
  fetchTelemetry,
  signIn,
  type LibraryTrack,
  type ReadinessRow,
  type TelemetryResponse,
  type TelemetryRow,
  type TrackSort,
} from './api.js';
import { Display } from './display/Display.js';
import {
  formatDuration,
  formatRemaining,
  formatSigned,
  leadTimeRemainingMs,
  offsetDeviations,
  readinessLabel,
  readinessWidths,
} from './format.js';
import { useDisco } from './useDisco.js';
import { visibleRange } from './virtual.js';

/** Height of one library row, in pixels. The windowing arithmetic needs it fixed. */
const ROW_HEIGHT = 44;

export function App() {
  const [role, setRole] = useState<Role | null | undefined>(undefined);

  // Resume an existing session rather than asking again. A reload mid-set is
  // common — a laptop wakes, a tab is restored — and re-entering the credential
  // at that moment is the last thing the DJ has attention for. On the projector
  // it would be worse: a sign-in form on a wall in front of a room.
  useEffect(() => {
    void currentRole().then(setRole);
  }, []);

  const path = window.location.pathname.replace(/\/+$/, '');
  const isDisplay = path.endsWith('/display');

  if (role === undefined) return <p className="muted loading">Checking session…</p>;

  if (isDisplay) {
    // The DJ credential opens the projector too, so setting it up does not
    // need a second code typed on a machine across the room.
    if (role === 'display' || role === 'dj') {
      return <Display debug={new URLSearchParams(window.location.search).has('debug')} />;
    }
    return (
      <SignIn
        title="Disco — projector"
        label="Display code"
        accepts={['display', 'dj']}
        // One browser holds one session per origin, so signing in here with
        // the display code replaces the dashboard's session in the same
        // browser. On the DJ's own laptop use the DJ credential; the display
        // code is for a projector driven by a second machine (D8).
        note="On the DJ's own laptop, use the DJ credential — the display code replaces the dashboard's session in the same browser."
        onSignedIn={setRole}
      />
    );
  }

  if (role === 'dj') return <Dashboard />;
  return <SignIn title="Disco — DJ" label="DJ credential" accepts={['dj']} onSignedIn={setRole} />;
}

function SignIn({
  title,
  label,
  accepts,
  note,
  onSignedIn,
}: {
  title: string;
  label: string;
  accepts: Role[];
  note?: string;
  onSignedIn: (role: Role) => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await signIn(code);
      if (!accepts.includes(session.role)) throw new Error('That code is not for this screen.');
      onSignedIn(session.role);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel signin" onSubmit={submit}>
      <h1>{title}</h1>
      <label htmlFor="code">{label}</label>
      <input
        id="code"
        type="password"
        autoComplete="current-password"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <button type="submit" disabled={busy || code.length === 0}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Dashboard() {
  const disco = useDisco(true);
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);
  const [now, setNow] = useState<number | null>(null);

  // A 200 ms readout tick. Position is computed from the clock, not counted up,
  // so a missed frame costs nothing.
  useEffect(() => {
    const timer = setInterval(() => setNow(disco.serverNow()), 200);
    return () => clearInterval(timer);
  }, [disco.serverNow]);

  useEffect(() => {
    const poll = () =>
      void fetchTelemetry()
        .then(setTelemetry)
        .catch(() => {});
    poll();
    const timer = setInterval(poll, 2_000);
    return () => clearInterval(timer);
  }, []);

  const send = disco.send;
  const state = disco.state;
  const current = state?.trackId ? disco.tracks.get(state.trackId) : undefined;

  const positionMs = useMemo(() => {
    if (!state || now === null) return 0;
    if (state.paused) return state.pausedAtPosition ?? 0;
    return Math.max(0, now - state.startAtServerTime);
  }, [state, now]);

  /**
   * The queue as this dashboard believes it to be.
   *
   * `queue.set` replaces the whole list, and the server's answer takes a round
   * trip to arrive. Reading `state.queue` for each edit means two quick clicks
   * both read the pre-first-click list and the second silently discards the
   * first — which is exactly what building a queue at speed looks like. So
   * edits apply to a ref updated synchronously, and server state reconciles it.
   */
  const queueRef = useRef<string[]>([]);
  useEffect(() => {
    if (state) queueRef.current = state.queue;
  }, [state]);

  const setQueue = useCallback(
    (trackIds: string[]) => {
      queueRef.current = trackIds;
      send({ t: 'queue.set', channelId: DEFAULT_CHANNEL_ID, trackIds });
    },
    [send],
  );

  const enqueue = (trackId: string) => setQueue([...queueRef.current, trackId]);
  const dequeue = (index: number) => setQueue(queueRef.current.filter((_, i) => i !== index));

  const clients = telemetry?.clients ?? [];
  const readinessFor = (trackId: string): ReadinessRow | undefined =>
    telemetry?.readiness.find((r) => r.trackId === trackId);

  return (
    <div className="dashboard">
      <StatusBar
        disco={disco}
        listeners={clients.filter((c) => c.role === 'guest' && c.playing).length}
        connected={clients.filter((c) => c.role === 'guest').length}
        venue={telemetry?.venue ?? '—'}
      />

      <section className="panel">
        <h2>Now playing</h2>
        {current ? (
          <>
            <p className="track">
              <strong>{current.title}</strong> — {current.artist}
            </p>
            <p className="times">
              {formatDuration(positionMs)} / {formatDuration(current.durationMs)}
              <span className="remaining"> −{formatRemaining(positionMs, current.durationMs)}</span>
              {current.bpm !== null && <span className="bpm"> · {current.bpm} bpm</span>}
              <span className="gain"> · {formatSigned(current.gainDb, 2)} dB</span>
            </p>
            <input
              className="scrub"
              type="range"
              min={0}
              max={Math.round(current.durationMs)}
              value={Math.round(positionMs)}
              onChange={(e) =>
                send({
                  t: 'transport.seek',
                  channelId: DEFAULT_CHANNEL_ID,
                  positionMs: Number(e.target.value),
                })
              }
            />
            <GainTrim trackId={current.trackId} send={send} />
            <Readiness
              row={readinessFor(current.trackId)}
              minLeadTimeMs={disco.config.minLeadTimeMs}
              serverNow={now}
            />
          </>
        ) : (
          <p className="muted">Nothing playing.</p>
        )}

        <div className="transport">
          <button onClick={() => send({ t: 'transport.play', channelId: DEFAULT_CHANNEL_ID })}>
            Play
          </button>
          <button onClick={() => send({ t: 'transport.pause', channelId: DEFAULT_CHANNEL_ID })}>
            Pause
          </button>
          <button onClick={() => send({ t: 'transport.skip', channelId: DEFAULT_CHANNEL_ID })}>
            Skip
          </button>
          {/* Re-sends state to the room. Every client recomputes its own
              position from it, so there is no separate catch-up path. */}
          <button onClick={() => send({ t: 'resync', channelId: DEFAULT_CHANNEL_ID })}>
            Resync all
          </button>
        </div>
        {disco.lastError && <p className="error">{disco.lastError}</p>}
      </section>

      <section className="panel">
        <h2>Queue ({state?.queue.length ?? 0})</h2>
        {(state?.queue ?? []).length === 0 ? (
          <p className="muted">Empty.</p>
        ) : (
          <ol className="queue">
            {(state?.queue ?? []).map((trackId, index) => {
              const meta = disco.tracks.get(trackId);
              return (
                <li key={`${trackId}-${index}`}>
                  <div className="queue-track">
                    <span>
                      {meta ? `${meta.title} — ${meta.artist}` : trackId}
                      {meta && <em> {formatDuration(meta.durationMs)}</em>}
                    </span>
                    <Readiness
                      row={readinessFor(trackId)}
                      minLeadTimeMs={disco.config.minLeadTimeMs}
                      serverNow={now}
                    />
                  </div>
                  <button onClick={() => dequeue(index)}>Remove</button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <Library
        onQueue={enqueue}
        onQueueAll={(ids) => setQueue([...queueRef.current, ...ids])}
        crates={disco.crates}
        queue={state?.queue ?? []}
        send={send}
      />

      <section className="panel">
        <h2>
          Comments ({disco.pending.length} pending
          {disco.config.moderationMode === 'open' ? ', open mode' : ''})
        </h2>
        <button
          className={disco.feedHidden ? 'panic active' : 'panic'}
          onClick={() => send({ t: 'feed.hide', hidden: !disco.feedHidden })}
        >
          {disco.feedHidden ? 'Feed hidden — show it' : 'Hide the feed'}
        </button>
        <ul className="comments">
          {disco.pending.map((item) => (
            <li key={item.id}>
              {/* React escapes this. Never innerHTML — it lands on a projector. */}
              <span>{item.text}</span>
              <button onClick={() => send({ t: 'comment.approve', id: item.id })}>Approve</button>
              <button onClick={() => send({ t: 'comment.reject', id: item.id })}>Reject</button>
            </li>
          ))}
        </ul>
        <h3>On the projector</h3>
        <ul className="comments">
          {disco.feed
            .slice()
            .reverse()
            .map((item) => (
              <li key={item.id}>
                <span>{item.text}</span>
                <button onClick={() => send({ t: 'comment.remove', id: item.id })}>Remove</button>
              </li>
            ))}
        </ul>
      </section>

      <ConfigPanel config={disco.config} send={send} downloads={telemetry?.downloads} />

      <Telemetry clients={clients} />
    </div>
  );
}

/** "28/30 ready" — the single widget that prevents most live failures (D5). */
function Readiness({
  row,
  minLeadTimeMs,
  serverNow,
}: {
  row: ReadinessRow | undefined;
  minLeadTimeMs: number;
  serverNow: number | null;
}) {
  if (!row) return null;
  const widths = readinessWidths(row);
  // A track that cannot start yet says so, rather than the DJ discovering it by
  // pressing play and being refused (D5).
  const lead =
    serverNow === null
      ? null
      : leadTimeRemainingMs(row.publishedAtServerTime, minLeadTimeMs, serverNow);

  return (
    <div className="readiness" title={readinessLabel(row)}>
      <div className="readiness-bar">
        <span className="readiness-partial" style={{ width: `${widths.partial * 100}%` }} />
        <span className="readiness-ready" style={{ width: `${widths.ready * 100}%` }} />
      </div>
      <span className="readiness-label">
        {readinessLabel(row)}
        {lead !== null && <em> · startable in {formatDuration(lead)}</em>}
      </span>
    </div>
  );
}

/**
 * Per-track gain trim (D11).
 *
 * Ingest normalises everything to the same loudness, which is right for the
 * great majority and wrong for the handful where the measurement and the dance
 * floor disagree. Sent on release rather than on every pixel of the drag: each
 * change re-broadcasts the track's metadata to the whole room.
 */
function GainTrim({ trackId, send }: { trackId: string; send: (m: unknown) => void }) {
  const [value, setValue] = useState(0);
  useEffect(() => setValue(0), [trackId]);

  return (
    <label className="trim">
      Gain trim {formatSigned(value, 1)} dB
      <input
        type="range"
        min={-12}
        max={12}
        step={0.5}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        onMouseUp={() => send({ t: 'track.gain', trackId, gainTrimDb: value })}
        onTouchEnd={() => send({ t: 'track.gain', trackId, gainTrimDb: value })}
        onKeyUp={() => send({ t: 'track.gain', trackId, gainTrimDb: value })}
      />
    </label>
  );
}

/**
 * The library (D10).
 *
 * Search, sort and paging all happen in SQL — the assumption is thousands of
 * tracks — and the rows on screen are windowed, so scrolling a large result set
 * costs the same as scrolling a small one.
 */
function Library({
  onQueue,
  onQueueAll,
  crates,
  queue,
  send,
}: {
  onQueue: (trackId: string) => void;
  onQueueAll: (trackIds: string[]) => void;
  crates: Array<{ name: string; trackIds: string[] }>;
  queue: string[];
  send: (message: unknown) => void;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<TrackSort>('artist');
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [total, setTotal] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [crateName, setCrateName] = useState('');

  useEffect(() => {
    let cancelled = false;
    // Debounced: a search box that fires a query per keystroke against a
    // thousand-row table makes the whole dashboard feel slow.
    const handle = setTimeout(() => {
      void fetchLibrary(query, { sort, limit: 500 })
        .then((r) => {
          if (cancelled) return;
          setTracks(r.tracks);
          setTotal(r.total);
          setScrollTop(0);
        })
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, sort]);

  const viewportHeight = ROW_HEIGHT * 8;
  const window_ = visibleRange({
    scrollTop,
    viewportHeight,
    rowHeight: ROW_HEIGHT,
    count: tracks.length,
  });

  return (
    <section className="panel">
      <h2>
        Library ({total} track{total === 1 ? '' : 's'})
      </h2>
      <div className="library-controls">
        <input
          className="search"
          type="search"
          placeholder="Search title, artist, album"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as TrackSort)}>
          <option value="artist">Artist</option>
          <option value="title">Title</option>
          <option value="bpm">BPM</option>
          <option value="recent">Recently added</option>
        </select>
      </div>

      <div
        className="library-viewport"
        style={{ height: viewportHeight }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: window_.totalHeight, position: 'relative' }}>
          <ul className="library" style={{ transform: `translateY(${window_.offsetY}px)` }}>
            {tracks.slice(window_.start, window_.end).map((track) => (
              <li key={track.trackId} style={{ height: ROW_HEIGHT }}>
                <span>
                  {track.title} — {track.artist}
                  <em>
                    {' '}
                    {formatDuration(track.durationMs)}
                    {track.bpm !== null && ` · ${Math.round(track.bpm)} bpm`}
                    {track.gainTrimDb !== 0 && ` · trim ${formatSigned(track.gainTrimDb, 1)} dB`}
                  </em>
                </span>
                <button onClick={() => onQueue(track.trackId)}>Queue</button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {tracks.length === 0 && <p className="muted">No tracks. Run the ingest CLI first.</p>}
      {total > tracks.length && (
        // Said out loud rather than silently truncated: a list that stops at
        // 500 without saying so reads as a library that is missing tracks.
        <p className="muted">
          Showing the first {tracks.length} of {total}. Narrow the search to see the rest.
        </p>
      )}

      <h3>Crates</h3>
      <div className="crates">
        {crates.map((crate) => (
          <div key={crate.name} className="crate">
            <button onClick={() => onQueueAll(crate.trackIds)}>
              {crate.name} <em>({crate.trackIds.length})</em>
            </button>
            <button
              className="crate-delete"
              aria-label={`Delete ${crate.name}`}
              onClick={() => send({ t: 'crate.delete', name: crate.name })}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="library-controls">
        <input
          className="search"
          type="text"
          placeholder="Save the queue as a crate"
          value={crateName}
          onChange={(e) => setCrateName(e.target.value)}
        />
        <button
          disabled={crateName.trim().length === 0 || queue.length === 0}
          onClick={() => {
            send({ t: 'crate.save', name: crateName.trim(), trackIds: queue });
            setCrateName('');
          }}
        >
          Save
        </button>
      </div>
    </section>
  );
}

/**
 * Remote config (D11).
 *
 * Everything here is changeable mid-event without a redeploy, which is the
 * point: the projector offset is measured by standing in the room and dragging
 * a slider, and the moderation mode is a decision that has to be visible and
 * reversible at 11pm.
 */
function ConfigPanel({
  config,
  send,
  downloads,
}: {
  config: ReturnType<typeof useDisco>['config'];
  send: (message: unknown) => void;
  downloads: TelemetryResponse['downloads'] | undefined;
}) {
  const set = (patch: Record<string, unknown>) => send({ t: 'config.set', patch });

  return (
    <section className="panel">
      <h2>Settings</h2>

      {/* One number for the whole room, set once per venue. Stand in the room
          in calibrated headphones, watch the projector, drag until the pulse
          matches the beat (D8). */}
      <label className="setting">
        Projector offset {config.projectorOffsetMs} ms
        <input
          type="range"
          min={-500}
          max={500}
          step={5}
          value={config.projectorOffsetMs}
          onChange={(e) => set({ projectorOffsetMs: Number(e.target.value) })}
        />
        <span className="muted">Raise it if the projector looks late.</span>
      </label>

      <div className="settings-grid">
        <label className="setting">
          Moderation
          <select
            value={config.moderationMode}
            onChange={(e) => set({ moderationMode: e.target.value })}
          >
            {MODERATION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>

        <label className="setting">
          Playback engine
          <select
            value={config.engineOverride}
            onChange={(e) => set({ engineOverride: e.target.value })}
          >
            {ENGINE_OVERRIDES.map((engine) => (
              <option key={engine} value={engine}>
                {engine}
              </option>
            ))}
          </select>
          <span className="muted">Forcing one rebuffers the room.</span>
        </label>

        <label className="setting">
          Prefetch horizon
          <input
            type="number"
            min={1}
            max={20}
            value={config.prefetchHorizonTracks}
            onChange={(e) => set({ prefetchHorizonTracks: Number(e.target.value) })}
          />
        </label>

        <label className="setting">
          Lead time (s)
          <input
            type="number"
            min={0}
            max={600}
            value={Math.round(config.minLeadTimeMs / 1000)}
            onChange={(e) => set({ minLeadTimeMs: Number(e.target.value) * 1000 })}
          />
        </label>

        <label className="setting">
          Concurrent downloads
          <input
            type="number"
            min={1}
            max={200}
            value={config.maxConcurrentSegmentDownloads}
            onChange={(e) => set({ maxConcurrentSegmentDownloads: Number(e.target.value) })}
          />
        </label>

        <label className="setting">
          Comments per minute
          <input
            type="number"
            min={0}
            max={120}
            value={config.commentsPerMinute}
            onChange={(e) => set({ commentsPerMinute: Number(e.target.value) })}
          />
        </label>

        <label className="setting">
          Media-element seek bias (ms)
          <input
            type="number"
            min={-200}
            max={500}
            value={config.mediaElementSeekBiasMs}
            onChange={(e) => set({ mediaElementSeekBiasMs: Number(e.target.value) })}
          />
        </label>
      </div>

      {downloads && (
        <p className="muted">
          Downloads: {downloads.inFlight} in flight · {downloads.queuedListeners} listeners and{' '}
          {downloads.queuedJoiners} joiners queued · peak {downloads.peakInFlight} · {downloads.queuedTotal}{' '}
          waited
          {downloads.admittedOverCapacity > 0 &&
            ` · ${downloads.admittedOverCapacity} admitted over the cap`}
        </p>
      )}
    </section>
  );
}

function Telemetry({ clients }: { clients: TelemetryRow[] }) {
  const deviations = useMemo(
    () => offsetDeviations(clients.map((row) => row.offsetMs)),
    [clients],
  );

  return (
    <section className="panel">
      <h2>Clients ({clients.length})</h2>
      <table className="telemetry">
        <thead>
          <tr>
            <th>Client</th>
            <th>Role</th>
            <th>Δ offset</th>
            <th>RTT</th>
            <th>Drift</th>
            <th>Calib.</th>
            <th>Engine</th>
            <th>Buffer</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((row, index) => (
            <tr key={row.clientId} className={row.playing ? 'playing' : undefined}>
              <td>{row.clientId.slice(0, 8)}</td>
              <td>{row.role}</td>
              {/* Relative to the room, not absolute: the spread is what is
                  audible, a shared offset is not (v4 Part 0). */}
              <td>{formatSigned(deviations[index], 1)}</td>
              <td>{row.rttMs?.toFixed(1) ?? '—'}</td>
              <td className={Math.abs(row.driftMs ?? 0) > 60 ? 'bad' : undefined}>
                {formatSigned(row.driftMs, 1)}
              </td>
              <td>{formatSigned(row.calibrationMs, 0)}</td>
              <td>{row.engine ?? '—'}</td>
              <td>{row.bufferSec?.toFixed(0) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function StatusBar({
  disco,
  listeners,
  connected,
  venue,
}: {
  disco: ReturnType<typeof useDisco>;
  listeners: number;
  connected: number;
  venue: string;
}) {
  return (
    <header className={`status ${disco.status}`}>
      <span className="dot" />
      <strong>{disco.status}</strong>
      {/* The raw offset is a thirteen-digit number and tells a human nothing.
          What is worth knowing at a glance is whether the clock is locked and
          how far away the server is. */}
      <span>clock {disco.clock.locked ? 'locked' : 'syncing…'}</span>
      <span>rtt {disco.clock.rttMs.toFixed(1)} ms</span>
      <span>
        {listeners}/{connected} listening
      </span>
      {/* A pending count on the transport view, so the DJ knows when the review
          stack is worth looking at without going to find it (D7). */}
      <span className={disco.pending.length > 0 ? 'pending' : 'pending none'}>
        {disco.pending.length} pending
      </span>
      <span className="venue">{venue}</span>
      {/* A mode you cannot see at a glance is a mode you will forget you are
          in (D7). */}
      <span className={`mode ${disco.config.moderationMode}`}>
        {disco.config.moderationMode} mode
      </span>
      {disco.feedHidden && <span className="mode hidden-feed">feed hidden</span>}
    </header>
  );
}

export type { StateMsg };
