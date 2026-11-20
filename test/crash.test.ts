/**
 * S8: the receiver process killed mid-request, then restarted on the same SQLite file while the
 * call goes on. Vapi never gets the answer, so the model calls the tool again with a new id.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { postRaw, toolCallsBody } from './support/fake-vapi.js';
import { startFakeStripe, type FakeStripe } from './support/fake-stripe.js';
import { FRIDAY_10AM, MONDAY } from './support/harness.js';
import { exitedAbruptly, hasStackTrace, startReceiverProcess } from './support/receiver-process.js';

const SLOT = `${MONDAY}T10:00`;
let dir: string;
let dbPath: string;
let stripe: FakeStripe;

async function tool(url: string, id: string, name: string, args: Record<string, unknown>) {
  const res = await postRaw(url, toolCallsBody('call-1', [{ id, name, args }]), FRIDAY_10AM.getTime());
  const entry = (res.json as { results: { result?: string; error?: string }[] }).results[0]!;
  return { status: res.status, result: entry.result ? (JSON.parse(entry.result) as Record<string, unknown>) : undefined, error: entry.error };
}

function count(sql: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('crash (S8)', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vapi-crash-'));
    dbPath = join(dir, 'receptionist.db');
    stripe = await startFakeStripe();
  });
  afterEach(async () => {
    await stripe.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('killed after the booking committed, before answering: the re-call returns that booking', async () => {
    const dying = await startReceiverProcess({ dbPath, stripeUrl: stripe.url, now: FRIDAY_10AM, fault: 'after_booking' });
    await assert.rejects(tool(dying.url, 'tc-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' }));
    const exit = await dying.exited;
    assert.equal(exit.crashedAt, 'after_booking');
    assert.ok(exitedAbruptly(exit) && !hasStackTrace(exit.output), exit.output);
    assert.equal(count('select count(*) as n from bookings'), 1);

    const restarted = await startReceiverProcess({ dbPath, stripeUrl: stripe.url, now: FRIDAY_10AM });
    try {
      const recall = await tool(restarted.url, 'tc-2', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' });
      assert.equal(recall.result!.status, 'booked');
      const redelivered = await tool(restarted.url, 'tc-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' });
      assert.equal(redelivered.result!.bookingCode, recall.result!.bookingCode);
      assert.equal(count('select count(*) as n from bookings'), 1);
    } finally {
      await restarted.stop();
    }
  });

  it('killed after Stripe created the session, before the local write: the retry replays it', async () => {
    const dying = await startReceiverProcess({ dbPath, stripeUrl: stripe.url, now: FRIDAY_10AM, fault: 'after_stripe' });
    const ref = (await tool(dying.url, 'tc-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingCode;
    await assert.rejects(tool(dying.url, 'tc-2', 'send_deposit_link', { bookingCode: ref }));
    const exit = await dying.exited;
    assert.equal(exit.crashedAt, 'after_stripe');
    assert.equal(stripe.created, 1);
    assert.equal(count(`select count(*) as n from deposits where status = 'creating' and session_id is null`), 1);

    const restarted = await startReceiverProcess({ dbPath, stripeUrl: stripe.url, now: FRIDAY_10AM });
    try {
      const retry = await tool(restarted.url, 'tc-3', 'send_deposit_link', { bookingCode: ref });
      assert.equal(retry.result!.status, 'link_sent');
      assert.equal(stripe.created, 1); // replayed by the Idempotency-Key, not created again
      assert.equal(count(`select count(*) as n from deposits where status = 'open' and session_id = 'cs_test_0001'`), 1);
    } finally {
      await restarted.stop();
    }
  });
});
