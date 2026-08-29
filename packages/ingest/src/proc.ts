/**
 * Child-process helpers.
 *
 * Everything expensive in ingest happens inside ffmpeg or aubio, so the "worker
 * pool" is really a process pool. Arguments are always passed as an array —
 * never a shell string — so a filename containing a quote or a semicolon is
 * data rather than a command.
 */

import { spawn } from 'node:child_process';

export class ToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: number | null,
    /** Tail of stderr. Tools are chatty; the last few lines carry the reason. */
    readonly detail: string,
  ) {
    super(`${tool} exited ${code ?? 'on signal'}: ${detail}`);
    this.name = 'ToolError';
  }
}

const STDERR_TAIL_LINES = 12;

function tail(text: string): string {
  return text.trimEnd().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Run a tool to completion, capturing text output. Rejects on a non-zero exit. */
export function run(tool: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // `-nostdin` is passed to ffmpeg by callers; closing stdin here as well
    // stops any tool from blocking the pool waiting on a prompt.
    const child = spawn(tool, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    child.on('error', (err) => reject(new ToolError(tool, null, err.message)));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ToolError(tool, code, tail(stderr)));
    });
  });
}

/**
 * Run a tool and hand each stdout chunk to a consumer as it arrives. Used for
 * raw PCM, which is tens of megabytes a track and must not be buffered whole.
 */
export function runStreaming(
  tool: string,
  args: readonly string[],
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (stderr += d));
    child.stdout.on('data', onChunk);
    child.on('error', (err) => reject(new ToolError(tool, null, err.message)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new ToolError(tool, code, tail(stderr)));
    });
  });
}

/** Whether a tool is on PATH, checked once at startup so failures are early and clear. */
export async function toolExists(tool: string, versionArg = '-version'): Promise<boolean> {
  try {
    await run(tool, [versionArg]);
    return true;
  } catch {
    return false;
  }
}
