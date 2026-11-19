import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CrashPoint } from '../../src/crash.js';
import { SECRET } from './fake-vapi.js';
import { STRIPE_KEY } from './harness.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  crashedAt: CrashPoint | undefined;
  output: string;
}

export interface ReceiverProcess {
  url: string;
  exited: Promise<ProcessExit>;
  stop(): Promise<ProcessExit>;
}

/** The receiver in a separate OS process: `node --import tsx src/main.ts`. Resolves once it listens. */
export function startReceiverProcess(opts: { dbPath: string; stripeUrl: string; now: Date; fault?: CrashPoint; side?: 'honest' | 'naive' }): Promise<ReceiverProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SIDE: opts.side ?? 'honest',
      DB_PATH: opts.dbPath,
      VAPI_SECRET: SECRET,
      STRIPE_BASE_URL: opts.stripeUrl,
      STRIPE_SECRET_KEY: STRIPE_KEY,
      CLOCK_NOW: opts.now.toISOString(),
      FAULT: opts.fault ?? '',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise<ProcessExit>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      const crashed = /crash: (after_booking|after_stripe)/.exec(output);
      resolve({ code, signal, crashedAt: crashed?.[1] as CrashPoint | undefined, output });
    });
  });

  return new Promise((resolve, reject) => {
    const onData = (d: Buffer) => {
      output += d.toString();
      const m = /listening on (http:\/\/\S+)/.exec(output);
      if (m) {
        child.stdout.off('data', onData);
        child.stdout.on('data', (more: Buffer) => (output += more.toString()));
        resolve({
          url: m[1]!,
          exited,
          stop: () => {
            child.kill();
            return exited;
          },
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    exited.then((e) => reject(new Error(`receiver exited before listening (code ${e.code}): ${e.output}`)), reject);
  });
}

/**
 * The process ended abruptly: SIGKILL on POSIX; on Windows exit code 1 with no signal, which an
 * uncaught exception also produces, so callers also check there is no stack trace.
 */
export function exitedAbruptly(exit: ProcessExit): boolean {
  return process.platform === 'win32' ? exit.code === 1 && exit.signal === null : exit.signal === 'SIGKILL';
}

export function hasStackTrace(output: string): boolean {
  return /^\s+at |Error:/m.test(output);
}
