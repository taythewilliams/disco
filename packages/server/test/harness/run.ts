/**
 * `disco-harness` — point N virtual clients at a running server.
 *
 * Against the real server on the real MacBook, this is the 30-client bandwidth
 * question answered without 30 phones. Against the venue's access point it is
 * the Phase 3 load test (D4, D13).
 *
 *   npx tsx packages/server/test/harness/run.ts --clients 30 --seconds 60
 */

import { parseArgs } from 'node:util';
import { formatReport, runHarness } from './harness.js';

const USAGE = `
disco-harness [options]

  --url <url>          Server base URL (default: http://127.0.0.1:3000)
  --code <code>        Event code. Falls back to DISCO_EVENT_CODE.
  --clients <n>        Simulated guests (default: 10)
  --channel <id>       Channel to subscribe to (default: main)
  --stagger <ms>       Gap between arrivals; 0 models a rush at the door
  --seconds <n>        How long to run (default: 30)
  --help
`.trimStart();

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:3000' },
      code: { type: 'string' },
      clients: { type: 'string', default: '10' },
      channel: { type: 'string', default: 'main' },
      stagger: { type: 'string', default: '200' },
      seconds: { type: 'string', default: '30' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const eventCode = values.code ?? process.env['DISCO_EVENT_CODE'];
  if (!eventCode) {
    // Never defaulted: a harness that guesses the event code is a harness that
    // silently tests nothing.
    process.stderr.write('Set --code or DISCO_EVENT_CODE.\n');
    return 1;
  }

  const clients = Number(values.clients);
  const seconds = Number(values.seconds);
  const stagger = Number(values.stagger);
  process.stdout.write(
    `Running ${clients} clients against ${values.url} for ${seconds}s ` +
      `(${stagger} ms stagger)…\n`,
  );

  const report = await runHarness({
    baseUrl: values.url as string,
    eventCode,
    clients,
    channelId: values.channel as string,
    arrivalStaggerMs: stagger,
    durationMs: seconds * 1000,
  });

  process.stdout.write(`\n${formatReport(report)}\n`);
  // A run where a client never locked its clock, or a fetch failed, is a
  // failure — not a report to eyeball and move on from.
  return report.failedRequests === 0 && report.locked === clients ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
