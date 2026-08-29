/**
 * `/selfcheck` — Spike 4's pass criteria, as a page a phone can load (D14).
 *
 * The spike asks four questions of a real device on the real network, and every
 * one of them is a browser question that no amount of server-side checking can
 * answer:
 *
 *   1. Does it load with no certificate warning?
 *   2. Does a service worker **register** and survive a reload? This is the
 *      real test — a service worker refuses to register on an origin with a
 *      certificate error even after the user clicks through, which is why
 *      self-signed fails decisively.
 *   3. Does `navigator.storage.persist()` return without throwing?
 *   4. What does `AudioContext.outputLatency` report? Spike 3 wants that number
 *      from every device it can get its hands on, to find out what calibration
 *      Layer 1 is actually worth (D1).
 *
 * Three hand-written assets rather than a fourth Vite app: this has to work
 * before the app does, and a page whose own build is part of what is being
 * tested proves nothing. No inline script, because the venue's CSP is
 * `script-src 'self'` (see ops/Caddyfile.example) and a page that fails there
 * would be testing the wrong thing.
 *
 * Unauthenticated on purpose. It carries no data and reveals nothing, and
 * requiring the event code to diagnose "the phone will not load the app" would
 * put the check behind the thing it is diagnosing.
 */

/** Scope kept narrow so this can never shadow the PWA's own worker at `/` (D15). */
export const SELFCHECK_SCOPE = '/selfcheck';

export const SELFCHECK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Disco — self check</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 24px 20px; background: #0f1115; color: #e6e9ef;
    font: 16px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  h1 { font-size: 1.2rem; margin: 0 0 4px; }
  p.sub { color: #939bab; margin: 0 0 20px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 12px 0; border-bottom: 1px solid #262b36; }
  .name { display: block; font-weight: 600; }
  .detail { color: #939bab; font-size: 0.9rem; }
  .pass::before { content: "✓ "; color: #6ee7b7; }
  .fail::before { content: "✗ "; color: #f87171; }
  .warn::before { content: "! "; color: #fbbf24; }
  .wait::before { content: "… "; color: #939bab; }
  button {
    margin-top: 20px; width: 100%; padding: 14px; font-size: 1rem;
    background: #262b36; color: #e6e9ef; border: 0; border-radius: 8px;
  }
</style>
</head>
<body>
  <h1>Disco — self check</h1>
  <p class="sub">Spike 4. Run this on the phone, on the venue network.</p>
  <ul id="checks"></ul>
  <button id="again">Reload and check again</button>
  <script src="/selfcheck.js"></script>
</body>
</html>
`;

export const SELFCHECK_JS = `/* Spike 4's checks. Plain ES2020: this runs on whatever a guest brought. */
const list = document.getElementById('checks');
const rows = new Map();

function row(key, name, level, detail) {
  let li = rows.get(key);
  if (!li) {
    li = document.createElement('li');
    rows.set(key, li);
    list.appendChild(li);
  }
  li.className = level;
  li.textContent = '';
  const strong = document.createElement('span');
  strong.className = 'name';
  strong.textContent = name;
  const small = document.createElement('span');
  small.className = 'detail';
  // textContent throughout: this page renders values from the device, and the
  // habit of never building HTML from data is the habit worth keeping.
  small.textContent = detail;
  li.append(strong, small);
}

row('secure', 'Secure context', 'wait', 'checking…');
row('sw', 'Service worker', 'wait', 'checking…');
row('persist', 'Persistent storage', 'wait', 'checking…');
row('audio', 'Audio output latency', 'wait', 'tap the button below if blank');
row('wake', 'Wake Lock', 'wait', 'checking…');
row('mode', 'Display mode', 'wait', 'checking…');

/* 1. The certificate question, asked the way the browser asks it. An origin
      with a bad certificate is not a secure context, and nothing else here
      would work either. */
if (window.isSecureContext) {
  row('secure', 'Secure context', 'pass', location.origin + ' — no certificate warning');
} else {
  row('secure', 'Secure context', 'fail', 'Not secure. No service worker, no PWA install (D14).');
}

/* 2. The real test. Registered under a narrow scope so it can never shadow the
      PWA's own worker, and unregistered afterwards so this page leaves nothing
      behind on a guest's phone. */
(async () => {
  if (!('serviceWorker' in navigator)) {
    row('sw', 'Service worker', 'fail', 'Not supported by this browser.');
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register('/selfcheck-sw.js', {
      scope: '/selfcheck',
    });
    await navigator.serviceWorker.ready;
    row('sw', 'Service worker', 'pass', 'Registered, scope ' + registration.scope);
    await registration.unregister();
  } catch (err) {
    row('sw', 'Service worker', 'fail', String(err && err.message ? err.message : err));
  }
})();

/* 3. May be declined, and that is fine — everything is re-fetchable from the
      LAN server. Treat it as a bonus, not a requirement (D15). */
(async () => {
  if (!navigator.storage || !navigator.storage.persist) {
    row('persist', 'Persistent storage', 'warn', 'API not available. Not fatal.');
    return;
  }
  try {
    const granted = await navigator.storage.persist();
    const estimate = navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const quota = estimate && estimate.quota ? Math.round(estimate.quota / 1e6) + ' MB quota' : '';
    row(
      'persist',
      'Persistent storage',
      granted ? 'pass' : 'warn',
      (granted ? 'Granted. ' : 'Declined — a bonus, not a requirement. ') + quota,
    );
  } catch (err) {
    row('persist', 'Persistent storage', 'fail', 'Threw: ' + String(err));
  }
})();

/* 4. Calibration Layer 1 (D1). Android Chrome reports something reflecting the
      real audio path; Safari is unreliable. Record it per device — Spike 3 uses
      these to decide what the automatic seed is worth. The context needs a user
      gesture on most browsers, hence the button. */
async function readAudioLatency() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    row('audio', 'Audio output latency', 'warn', 'No Web Audio on this browser.');
    return;
  }
  const context = new Ctx();
  try {
    await context.resume();
  } catch (err) {
    /* Left suspended: the reading below is still worth printing. */
  }
  const output = typeof context.outputLatency === 'number' ? context.outputLatency : null;
  const base = typeof context.baseLatency === 'number' ? context.baseLatency : null;
  const parts = [];
  if (output !== null) parts.push('outputLatency ' + Math.round(output * 1000) + ' ms');
  if (base !== null) parts.push('baseLatency ' + Math.round(base * 1000) + ' ms');
  parts.push('sampleRate ' + context.sampleRate + ' Hz');
  parts.push('state ' + context.state);
  row(
    'audio',
    'Audio output latency',
    output !== null ? 'pass' : 'warn',
    parts.join(' · ') + (output === null ? ' — not reported here, use a preset (D1)' : ''),
  );
  await context.close();
}
document.addEventListener('click', function once() {
  document.removeEventListener('click', once);
  readAudioLatency();
});
readAudioLatency();

/* 5. Wake Lock, so the screen does not sleep mid-set (D16). Presence only —
      actually holding one needs a gesture and is the app's job. */
row(
  'wake',
  'Wake Lock',
  'wakeLock' in navigator ? 'pass' : 'warn',
  'wakeLock' in navigator ? 'Available' : 'Not available — the screen will sleep on its own.',
);

/* 6. Installed or not. An installed iOS PWA runs in its own storage container
      with its own service worker registration, so this page in Safari says
      nothing about the installed app — run it again from the home screen. */
const standalone =
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
row(
  'mode',
  'Display mode',
  'pass',
  standalone
    ? 'Installed — this is the PWA container'
    : 'Browser tab. Install and run this again: iOS keeps a separate container (D15).',
);

document.getElementById('again').addEventListener('click', () => location.reload());
`;

/**
 * The trivial worker the check registers.
 *
 * It deliberately does nothing: caching anything here would put this page's
 * assets in a guest's storage, and the only question being asked is whether
 * registration succeeds at all.
 */
export const SELFCHECK_SW = `/* Spike 4 probe. Registers, claims nothing, caches nothing. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
`;
