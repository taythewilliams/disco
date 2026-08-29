/**
 * Certificate check for the venue hostname (D14 step 6).
 *
 * Caddy auto-renews *if* it can reach the Cloudflare API, which needs the
 * uplink. Trusting that silently is how an expired certificate is discovered at
 * the door — and an expired certificate is the same failure as a self-signed
 * one: no service worker, no PWA, no install. So this is a command you run
 * before every event rather than an assumption you carry into one.
 *
 *   node ops/scripts/cert-check.mjs party.example.com
 *   node ops/scripts/cert-check.mjs party.example.com --days 21
 *
 * Exits non-zero when the certificate is invalid, expired, or closer to expiry
 * than the threshold, so it can gate a checklist or a cron.
 */

import { connect } from 'node:tls';
import { parseArgs } from 'node:util';

/** Let's Encrypt certificates last 90 days; renewal starts at 30 remaining. */
const DEFAULT_MIN_DAYS = 21;
const CONNECT_TIMEOUT_MS = 8_000;

/**
 * Fetch the leaf certificate and whether the chain validates.
 *
 * `rejectUnauthorized: false` so that an *invalid* certificate is reported
 * rather than thrown — the failure this exists to catch would otherwise become
 * a stack trace with no detail in it. `authorized` still carries the verdict.
 */
export function inspect(host, port = 443) {
  return new Promise((resolve, reject) => {
    const socket = connect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: CONNECT_TIMEOUT_MS },
      () => {
        const cert = socket.getPeerCertificate(false);
        const result = {
          authorized: socket.authorized,
          authorizationError: socket.authorizationError?.message ?? null,
          subject: cert.subject?.CN ?? '(none)',
          issuer: cert.issuer?.O ?? cert.issuer?.CN ?? '(none)',
          altNames: cert.subjectaltname ?? '',
          validFrom: cert.valid_from ? new Date(cert.valid_from) : null,
          validTo: cert.valid_to ? new Date(cert.valid_to) : null,
          protocol: socket.getProtocol(),
        };
        socket.end();
        resolve(result);
      },
    );
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`no answer from ${host}:${port} within ${CONNECT_TIMEOUT_MS} ms`));
    });
    socket.on('error', reject);
  });
}

/** Whole days remaining, rounded down. Negative once expired. */
export function daysUntil(validTo, now) {
  if (!validTo) return null;
  return Math.floor((validTo.getTime() - now) / 86_400_000);
}

/** True when the certificate covers the hostname, directly or by wildcard. */
export function covers(altNames, host) {
  const names = altNames
    .split(',')
    .map((n) => n.trim().replace(/^DNS:/, ''))
    .filter(Boolean);
  return names.some((name) => {
    if (name === host) return true;
    if (!name.startsWith('*.')) return false;
    // One label only: `*.example.com` covers `party.example.com` and not
    // `a.b.example.com`, which is what the rules actually say.
    const suffix = name.slice(1);
    return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes('.');
  });
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      days: { type: 'string' },
      port: { type: 'string', default: '443' },
      help: { type: 'boolean', default: false },
    },
  });

  const host = positionals[0] ?? process.env['DISCO_PUBLIC_HOST'];
  if (values.help || !host) {
    process.stdout.write(
      'cert-check <hostname> [--days 21] [--port 443]\n' +
        '  Falls back to DISCO_PUBLIC_HOST when no hostname is given.\n',
    );
    return host ? 0 : 1;
  }

  const minDays = Number(values.days ?? DEFAULT_MIN_DAYS);
  let cert;
  try {
    cert = await inspect(host, Number(values.port));
  } catch (err) {
    process.stdout.write(`✗ ${host}: ${err instanceof Error ? err.message : String(err)}\n`);
    // A hostname that resolves to a private address is unreachable from
    // anywhere but the venue LAN, which is the most likely reason to be here.
    process.stdout.write('  Run this on the venue network, with the server up.\n');
    return 1;
  }

  const remaining = daysUntil(cert.validTo, Date.now());
  const lines = [
    `host      ${host}`,
    `subject   ${cert.subject}`,
    `issuer    ${cert.issuer}`,
    `protocol  ${cert.protocol}`,
    `expires   ${cert.validTo?.toISOString() ?? 'unknown'} (${remaining ?? '?'} days)`,
  ];

  const problems = [];
  if (!cert.authorized) {
    problems.push(`chain does not validate: ${cert.authorizationError ?? 'unknown'}`);
  }
  if (!covers(cert.altNames, host)) problems.push(`certificate does not cover ${host}`);
  if (remaining === null) problems.push('no expiry on the certificate');
  else if (remaining < 0) problems.push('certificate has expired');
  else if (remaining < minDays) problems.push(`fewer than ${minDays} days remaining`);

  process.stdout.write(`${lines.join('\n')}\n`);
  if (problems.length === 0) {
    process.stdout.write(`✓ valid and good for ${remaining} more days\n`);
    return 0;
  }

  for (const problem of problems) process.stdout.write(`✗ ${problem}\n`);
  process.stdout.write(
    '\nTo force a renewal:  caddy reload --config ops/Caddyfile\n' +
      'Caddy needs the uplink to reach the Cloudflare API — check that first.\n',
  );
  return 1;
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
