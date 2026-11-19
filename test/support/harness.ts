import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHonestReceptionist } from '../../src/honest/receptionist.js';
import type { Receptionist } from '../../src/receptionist.js';
import { createReceiver } from '../../src/server.js';
import { createStripeClient } from '../../src/stripe.js';
import { CALLER, postRaw, SECRET, toolCallsBody, transferBody } from './fake-vapi.js';
import { startFakeStripe, type FakeStripe } from './fake-stripe.js';

/** Friday 2026-11-20, 10:00 at the clinic (UTC-5): open. */
export const FRIDAY_10AM = new Date('2026-11-20T15:00:00Z');
/** Monday 2026-11-23: the day the scripted calls book on. */
export const MONDAY = '2026-11-23';

export const STRIPE_KEY = 'sk_test_fake';

export interface ToolAnswer {
  status: number;
  toolCallId: string;
  /** The parsed `result` string, when the tool succeeded. */
  result?: Record<string, unknown>;
  error?: string;
}

export interface Rig {
  url: string;
  stripe: FakeStripe;
  /** A read-only view of the receiver's SQLite file. */
  db: Database.Database;
  dbPath: string;
  setNow(d: Date): void;
  advanceMinutes(m: number): void;
  now(): Date;
  /** One tool call in its own `tool-calls` message, signed like Vapi does. */
  tool(callId: string, name: string, args: Record<string, unknown>, opts?: { id?: string; caller?: string }): Promise<ToolAnswer>;
  transfer(callId: string): Promise<{ status: number; json: unknown }>;
  close(): Promise<void>;
}

export type Factory = (o: { dbPath: string; stripe: ReturnType<typeof createStripeClient>; now: () => Date }) => Receptionist;

export const honest: Factory = (o) => createHonestReceptionist(o);

let toolCallCounter = 0;

/** A receiver in this process, a fake Stripe and a clock the test moves. */
export async function startRig(factory: Factory = honest): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'vapi-proof-'));
  const dbPath = join(dir, 'receptionist.db');
  const stripe = await startFakeStripe();
  let now = FRIDAY_10AM;
  const receptionist = factory({ dbPath, stripe: createStripeClient({ baseUrl: stripe.url, secretKey: STRIPE_KEY }), now: () => now });
  const server: Server = createReceiver({ receptionist, secret: SECRET, now: () => now, log: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const db = new Database(dbPath, { readonly: true });

  return {
    url,
    stripe,
    db,
    dbPath,
    setNow: (d) => (now = d),
    advanceMinutes: (m) => (now = new Date(now.getTime() + m * 60_000)),
    now: () => now,
    async tool(callId, name, args, opts = {}) {
      const toolCallId = opts.id ?? `tc-${++toolCallCounter}`;
      const res = await postRaw(url, toolCallsBody(callId, [{ id: toolCallId, name, args }], opts.caller ?? CALLER), now.getTime());
      const entry = (res.json as { results?: { toolCallId: string; result?: string; error?: string }[] } | undefined)?.results?.[0];
      return {
        status: res.status,
        toolCallId: entry?.toolCallId ?? '',
        result: entry?.result !== undefined ? (JSON.parse(entry.result) as Record<string, unknown>) : undefined,
        error: entry?.error,
      };
    },
    transfer: (callId) => postRaw(url, transferBody(callId), now.getTime()),
    async close() {
      db.close();
      await new Promise<void>((r) => server.close(() => r()));
      receptionist.close();
      await stripe.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Rows of a table, for assertions. */
export function rows<T = Record<string, unknown>>(rig: Rig, sql: string, ...params: unknown[]): T[] {
  return rig.db.prepare(sql).all(...params) as T[];
}
