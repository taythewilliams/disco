/**
 * Venue preflight (D14, Phase 4's runbook, run first in Phase 0's Spike 4).
 *
 * Everything that has to be true before doors, checked in one command instead
 * of from memory at 7pm. Each check prints a verdict and, when it fails, the
 * one thing to do about it — a check that says "DNS wrong" and stops is a check
 * that gets ignored.
 *
 *   node --env-file=.env ops/scripts/preflight.mjs --host party.example.com --ip 192.168.4.10
 *
 * Exits non-zero if anything failed, so it can gate the checklist. Warnings do
 * not fail the run: they are the things that are usually fine and occasionally
 * the whole problem.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Resolver, promises as dns } from 'node:dns';
import { join, resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { covers, daysUntil, inspect } from './cert-check.mjs';

/** Renewal starts at 30 days; below this, do it deliberately before the event. */
const MIN_CERT_DAYS = 21;
const HTTP_TIMEOUT_MS = 5_000;

const results = [];
const pass = (name, detail) => results.push({ level: 'pass', name, detail });
const warn = (name, detail, fix) => results.push({ level: 'warn', name, detail, fix });
const fail = (name, detail, fix) => results.push({ level: 'fail', name, detail, fix });

/** Fetch with a timeout: an unreachable venue server must not hang the check. */
async function get(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Checks ──────────────────────────────────────────────────────────────────

/**
 * Secrets, without printing any of them.
 *
 * Lengths and presence only. A preflight that echoes the DJ credential to a
 * terminal in a venue is a preflight that leaks it (D12).
 */
function checkEnv(env) {
  const required = [
    ['DISCO_EVENT_CODE', 4],
    ['DISCO_DJ_PASSWORD', 12],
    ['DISCO_SESSION_SECRET', 32],
  ];
  for (const [name, minLength] of required) {
    const value = env[name];
    if (!value) fail(name, 'not set', `Set ${name} in .env — the server refuses to boot without it.`);
    else if (value.length < minLength) {
      fail(name, `${value.length} characters`, `Needs at least ${minLength}.`);
    } else pass(name, `set, ${value.length} characters`);
  }

  if (env['DISCO_DISPLAY_CODE']) pass('DISCO_DISPLAY_CODE', 'set — the projector can sign in');
  else warn('DISCO_DISPLAY_CODE', 'not set', 'Only needed if the projector is a second machine (D8).');

  if (env['DISCO_INSECURE_COOKIES'] === '1') {
    fail(
      'DISCO_INSECURE_COOKIES',
      'enabled',
      'Unset it. A session cookie without Secure is a session cookie readable on the venue Wi-Fi.',
    );
  } else pass('cookies', 'Secure flag on');

  if (!process.env['CLOUDFLARE_API_TOKEN']) {
    warn(
      'CLOUDFLARE_API_TOKEN',
      'not in this shell',
      'Caddy needs it to renew. Fine if Caddy is started from a different environment.',
    );
  } else pass('CLOUDFLARE_API_TOKEN', 'present');
}

/**
 * Public DNS and the access point's local override (D14 step 5).
 *
 * Both matter. Some resolvers implement DNS rebinding protection and refuse to
 * return a private address for a public hostname, which breaks things silently
 * for the guests using them — so the AP answers authoritatively at the venue
 * and public DNS is the fallback.
 */
async function checkDns(host, expectedIp) {
  try {
    const addresses = await dns.resolve4(host);
    if (!expectedIp) pass('DNS (system resolver)', addresses.join(', '));
    else if (addresses.includes(expectedIp)) pass('DNS (system resolver)', addresses.join(', '));
    else {
      fail(
        'DNS (system resolver)',
        `${addresses.join(', ')}, expected ${expectedIp}`,
        'If these are Cloudflare addresses the record is proxied — set it to DNS-only (grey cloud).',
      );
    }
  } catch (err) {
    fail(
      'DNS (system resolver)',
      err instanceof Error ? err.message : 'lookup failed',
      'Check the A record exists and the venue resolver is reachable.',
    );
  }

  // Straight to Cloudflare, bypassing anything local, to tell "the record is
  // wrong" apart from "this resolver refuses to hand back a private address".
  const upstream = new Resolver();
  upstream.setServers(['1.1.1.1']);
  await new Promise((done) => {
    upstream.resolve4(host, (err, addresses) => {
      if (err) warn('DNS (1.1.1.1)', err.message, 'No uplink, or the public record is missing.');
      else if (expectedIp && !addresses.includes(expectedIp)) {
        warn('DNS (1.1.1.1)', `${addresses.join(', ')}, expected ${expectedIp}`, 'Public record disagrees with the venue.');
      } else pass('DNS (1.1.1.1)', addresses.join(', '));
      done();
    });
  });
}

async function checkCertificate(host) {
  try {
    const cert = await inspect(host);
    const remaining = daysUntil(cert.validTo, Date.now());
    if (!cert.authorized) {
      fail('certificate', cert.authorizationError ?? 'chain does not validate', 'No valid certificate means no service worker and no PWA (D14).');
    } else if (!covers(cert.altNames, host)) {
      fail('certificate', `does not cover ${host}`, 'Reissue for the hostname guests actually type.');
    } else if (remaining !== null && remaining < MIN_CERT_DAYS) {
      fail('certificate', `${remaining} days left`, 'caddy reload --config ops/Caddyfile — needs the uplink.');
    } else {
      pass('certificate', `${cert.issuer}, ${remaining} days left`);
    }
  } catch (err) {
    fail(
      'certificate',
      err instanceof Error ? err.message : 'connection failed',
      'Is Caddy running, and are you on the venue network?',
    );
  }
}

async function checkServer(origin) {
  try {
    const response = await get(`${origin}/api/health`);
    if (!response.ok) {
      fail('server', `/api/health returned ${response.status}`, 'Check the Node process and the reverse proxy.');
      return;
    }
    const body = await response.json();
    pass('server', `up, ${body.connections} connection(s)`);
  } catch (err) {
    fail(
      'server',
      err instanceof Error ? err.message : 'unreachable',
      'Start it: node --env-file=.env --import tsx packages/server/src/main.ts',
    );
  }
}

/** The library, and whether anything is actually ingested (D10). */
function checkMedia(mediaRoot) {
  const db = join(mediaRoot, 'disco.db');
  if (!existsSync(db)) {
    fail('library', `no manifest at ${db}`, 'Run the ingest CLI over the music directory.');
    return;
  }
  const tracks = join(mediaRoot, 'tracks');
  const count = existsSync(tracks) ? statSync(tracks).isDirectory() : false;
  if (!count) fail('library', 'no tracks directory', 'Run the ingest CLI.');
  else pass('library', `manifest and tracks present in ${mediaRoot}`);
}

/**
 * The built apps.
 *
 * In development Vite serves them; at the venue this process does, and a
 * missing `dist` means a phone at the door gets a 404 rather than the app.
 */
async function checkBuilds(guestDir, hostDir) {
  for (const [name, dir, hint] of [
    ['guest PWA', guestDir, 'npm run build --workspace @disco/guest'],
    ['dashboard', hostDir, 'npm run build --workspace @disco/host'],
  ]) {
    if (!existsSync(join(dir, 'index.html'))) fail(name, `no build at ${dir}`, hint);
    else pass(name, `built at ${dir}`);
  }

  // The service worker is what makes the PWA installable, and it only exists
  // if the guest build ran with the PWA plugin enabled (D15).
  if (existsSync(join(guestDir, 'sw.js'))) pass('service worker', 'in the guest build');
  else warn('service worker', 'no sw.js in the guest build', 'Without it there is no install and no offline shell.');
}

/**
 * The uplink (D13).
 *
 * Two things need it: Caddy renewing the certificate, and phones' own
 * connectivity checks — a phone that decides the Wi-Fi has no internet may
 * silently fall back to cellular and never reach the venue server at all.
 */
async function checkUplink() {
  try {
    await dns.resolve4('acme-v02.api.letsencrypt.org');
    pass('uplink', 'DNS resolves upstream');
  } catch {
    warn(
      'uplink',
      'no upstream DNS',
      'Phones may fall back to cellular, and Caddy cannot renew. Check the 4G router.',
    );
  }
}

/** The venue profile: the projector offset measured in this room (D8). */
async function checkVenueProfile(path) {
  if (!existsSync(path)) {
    warn('venue profile', `none at ${path}`, 'Expected on a first visit. Set the projector offset before doors.');
    return;
  }
  try {
    const profile = JSON.parse(await readFile(path, 'utf8'));
    const offset = profile?.config?.projectorOffsetMs;
    if (typeof offset !== 'number') {
      warn('venue profile', 'no projector offset saved', 'Set it from the dashboard slider with the projector running.');
    } else {
      pass('venue profile', `projector offset ${offset} ms, ${profile.crates?.length ?? 0} crate(s)`);
    }
  } catch {
    warn('venue profile', 'unreadable', 'The server ignores it and starts from defaults.');
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string' },
      ip: { type: 'string' },
      origin: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(
      'preflight [--host party.example.com] [--ip 192.168.4.10] [--origin https://…]\n' +
        '  --host    public hostname; falls back to DISCO_PUBLIC_HOST\n' +
        '  --ip      the address that hostname must resolve to\n' +
        '  --origin  what to health-check; defaults to https://<host>\n',
    );
    return 0;
  }

  const host = values.host ?? process.env['DISCO_PUBLIC_HOST'] ?? null;
  const mediaRoot = resolvePath(process.env['DISCO_MEDIA_ROOT'] ?? 'media');
  const venue = process.env['DISCO_VENUE'] ?? 'default';

  checkEnv(process.env);
  checkMedia(mediaRoot);
  await checkBuilds(
    resolvePath(process.env['DISCO_GUEST_DIR'] ?? 'apps/guest/dist'),
    resolvePath(process.env['DISCO_HOST_DIR'] ?? 'apps/host/dist'),
  );
  await checkVenueProfile(
    resolvePath(process.env['DISCO_VENUE_FILE'] ?? join(mediaRoot, `venue-${venue}.json`)),
  );
  await checkUplink();

  if (host) {
    await checkDns(host, values.ip ?? null);
    await checkCertificate(host);
    await checkServer(values.origin ?? `https://${host}`);
  } else {
    // Without a hostname the DNS and certificate checks are the ones that
    // cannot run, and they are the ones that fail at the door.
    warn('hostname', 'not given', 'Pass --host or set DISCO_PUBLIC_HOST to check DNS, TLS and the server.');
    if (values.origin) await checkServer(values.origin);
  }

  const mark = { pass: '✓', warn: '!', fail: '✗' };
  const width = Math.max(...results.map((r) => r.name.length));
  for (const result of results) {
    process.stdout.write(`${mark[result.level]} ${result.name.padEnd(width)}  ${result.detail}\n`);
    if (result.fix) process.stdout.write(`${' '.repeat(width + 4)}${result.fix}\n`);
  }

  const failures = results.filter((r) => r.level === 'fail').length;
  const warnings = results.filter((r) => r.level === 'warn').length;
  process.stdout.write(
    `\n${results.length - failures - warnings} passed, ${warnings} warning(s), ${failures} failure(s)\n`,
  );
  return failures > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
