import { writeSync } from 'node:fs';

/**
 * Fault injection for the crash tests. The receiver process kills itself with SIGKILL at the
 * selected point: no `finally`, no shutdown hook, no chance to write anything else.
 *
 *   after_booking  the booking transaction committed, the answer to Vapi not sent
 *   after_stripe   Stripe created the Checkout Session, the local row not updated
 */
export const CRASH_POINTS = ['after_booking', 'after_stripe'] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export function crashIfAt(selected: CrashPoint | undefined, point: CrashPoint): void {
  if (selected !== point) return;
  writeSync(2, `crash: ${point}\n`); // synchronous, so the marker is out before the process dies
  process.kill(process.pid, 'SIGKILL');
}
