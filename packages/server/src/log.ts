/**
 * Logging (D12).
 *
 * Connection events and errors, never payloads and never comment text. The
 * point is not tidiness: comments are ephemeral by design and deleted after the
 * event, and a log file that quietly retains them defeats that.
 *
 * The `event` helper takes named fields rather than a free-text message so a
 * caller cannot accidentally interpolate guest text into a log line.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  event(level: LogLevel, name: string, fields?: Record<string, string | number | boolean>): void;
}

/** Values that must never reach a log line, whatever a caller passes. */
const REDACTED = '[redacted]';
const FORBIDDEN_FIELDS = new Set(['text', 'comment', 'password', 'code', 'token', 'secret']);

export function createLogger(write: (line: string) => void = (l) => process.stdout.write(l)): Logger {
  return {
    event(level, name, fields = {}) {
      const parts = [new Date().toISOString(), level.toUpperCase(), name];
      for (const [key, value] of Object.entries(fields)) {
        parts.push(`${key}=${FORBIDDEN_FIELDS.has(key) ? REDACTED : formatValue(value)}`);
      }
      write(`${parts.join(' ')}\n`);
    },
  };
}

function formatValue(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value);
  // Newlines would let a value forge a second log line.
  const clean = value.replace(/[\r\n]+/g, ' ');
  return /\s/.test(clean) ? JSON.stringify(clean) : clean;
}

export const silentLogger: Logger = { event: () => {} };
