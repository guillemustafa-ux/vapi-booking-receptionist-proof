/**
 * The ways a voice call duplicates work, and what the honest receptionist does about each:
 *
 *   S4  Vapi redelivers a tool call (same toolCallId): `backoffPlan` retries, or a captured
 *       signed request replayed inside the 5-minute freshness window
 *   S5  the model calls the tool again with a NEW toolCallId after a slow answer
 *   S6  two callers race for one slot
 *   S7  the Stripe answer is lost, Stripe fails, or Stripe is down when a hold runs out
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MONDAY, rows, startRig, type Rig } from './support/harness.js';

const SLOT = `${MONDAY}T10:00`;
const OTHER_CALLER = '+15555550999';
let rig: Rig;

describe('duplicates', () => {
  beforeEach(async () => {
    rig = await startRig();
  });
  afterEach(() => rig.close());

  it('S4: a redelivered book_appointment (same toolCallId) answers the stored result and books once', async () => {
    const first = await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' }, { id: 'tc-book' });
    const again = await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' }, { id: 'tc-book' });
    assert.deepEqual(again, first);
    assert.equal(rows(rig, 'select * from bookings').length, 1);
    assert.deepEqual(rows(rig, `select deliveries, status from tool_calls where tool_call_id = 'tc-book'`), [{ deliveries: 2, status: 'done' }]);
  });

  it('S4: a redelivered send_deposit_link does not call Stripe again', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref }, { id: 'tc-dep' });
    const requests = rig.stripe.requests;
    await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref }, { id: 'tc-dep' });
    assert.equal(rig.stripe.requests, requests);
    assert.equal(rig.stripe.created, 1);
  });

  it('S5: the model re-calling book_appointment with a new id gets the same booking back', async () => {
    const first = await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' });
    const recall = await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' });
    assert.notEqual(recall.toolCallId, first.toolCallId);
    assert.equal(recall.result!.status, 'booked');
    assert.equal(recall.result!.bookingRef, first.result!.bookingRef);
    assert.equal(rows(rig, 'select * from bookings').length, 1);
  });

  it('S5: a second slot in the same call is refused with the existing booking, not booked twice', async () => {
    const first = await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' });
    const other = await rig.tool('call-1', 'book_appointment', { slot: `${MONDAY}T11:00`, name: 'Ana Ruiz' });
    assert.equal(other.result!.status, 'already_booked');
    assert.equal(other.result!.bookingRef, first.result!.bookingRef);
    assert.equal(rows(rig, `select * from bookings where status in ('held','confirmed')`).length, 1);
  });

  it('S5: send_deposit_link re-called with new ids creates one Checkout Session and returns the same link', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    const a = await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref });
    const b = await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref });
    assert.equal(b.result!.url, a.result!.url);
    assert.equal(rig.stripe.created, 1);
  });

  it('S6: two callers racing for one slot: exactly one booking', async () => {
    const [a, b] = await Promise.all([
      rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' }),
      rig.tool('call-2', 'book_appointment', { slot: SLOT, name: 'Ben Cole' }, { caller: OTHER_CALLER }),
    ]);
    assert.deepEqual([a.result!.status, b.result!.status].sort(), ['booked', 'slot_taken']);
    assert.equal(rows(rig, `select * from bookings where slot = ?`, SLOT).length, 1);
  });

  it('S6: a reschedule onto a taken slot is refused and the booking stays where it was', async () => {
    await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' });
    const ben = (await rig.tool('call-2', 'book_appointment', { slot: `${MONDAY}T11:00`, name: 'Ben Cole' }, { caller: OTHER_CALLER })).result!;
    const moved = await rig.tool('call-3', 'reschedule_appointment', { bookingRef: ben.bookingRef, newSlot: SLOT }, { caller: OTHER_CALLER });
    assert.equal(moved.result!.status, 'slot_taken');
    assert.deepEqual(rows(rig, 'select slot from bookings where ref = ?', ben.bookingRef), [{ slot: `${MONDAY}T11:00` }]);
  });

  it('only the caller who booked can move or cancel it', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    const cancel = await rig.tool('call-2', 'cancel_appointment', { bookingRef: ref }, { caller: OTHER_CALLER });
    assert.equal(cancel.result!.status, 'not_found');
    assert.deepEqual(rows(rig, 'select status from bookings'), [{ status: 'held' }]);
  });

  it('a phone number said on another line is not proof of ownership', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    const spoof = await rig.tool('call-2', 'cancel_appointment', { bookingRef: ref, phone: '+15555550123' }, { caller: OTHER_CALLER });
    assert.equal(spoof.result!.status, 'not_found');
    assert.deepEqual(rows(rig, 'select status from bookings'), [{ status: 'held' }]);
  });

  it('S7: a lost Stripe answer is retried with the same key: the session is replayed, not created again', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    rig.stripe.failNext('drop');
    const lost = await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref });
    assert.match(lost.error!, /did not confirm/);
    assert.equal(rig.stripe.created, 1);
    assert.deepEqual(rows(rig, 'select status, session_id from deposits'), [{ status: 'unknown', session_id: null }]);

    const retry = await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref });
    assert.equal(retry.result!.status, 'link_sent');
    assert.equal(rig.stripe.created, 1);
    assert.deepEqual(rows(rig, 'select status, session_id from deposits'), [{ status: 'open', session_id: 'cs_test_0001' }]);
  });

  it('S7: a Stripe 500 creates nothing; the retry creates one session', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    rig.stripe.failNext('500');
    assert.ok((await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref })).error);
    assert.equal(rig.stripe.created, 0);
    assert.equal((await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref })).result!.status, 'link_sent');
    assert.equal(rig.stripe.created, 1);
  });

  it('S7: a deposit paid after the hold ran out confirms the booking instead of releasing the slot', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref });
    rig.stripe.pay(rig.stripe.sessionIds()[0]!); // paid, but nobody asked before the hold ran out
    rig.advanceMinutes(20);

    const second = await rig.tool('call-2', 'book_appointment', { slot: SLOT, name: 'Ben Cole' }, { caller: OTHER_CALLER });
    assert.equal(second.result!.status, 'slot_taken');
    assert.deepEqual(rows(rig, 'select name, status from bookings'), [{ name: 'Ana Ruiz', status: 'confirmed' }]);
  });

  it('S7: with Stripe unreachable when the hold runs out, the hold stays until Stripe can be asked', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref });
    rig.advanceMinutes(20);
    rig.stripe.goDark();
    const blocked = await rig.tool('call-2', 'book_appointment', { slot: SLOT, name: 'Ben Cole' }, { caller: OTHER_CALLER });
    assert.equal(blocked.result!.status, 'slot_taken');
    assert.deepEqual(rows(rig, 'select status from bookings'), [{ status: 'held' }]);

    rig.stripe.answerAgain(); // unpaid: now it is released
    const later = await rig.tool('call-3', 'book_appointment', { slot: SLOT, name: 'Ben Cole' }, { caller: OTHER_CALLER });
    assert.equal(later.result!.status, 'booked');
  });

  it('invalid arguments come back as an error result with HTTP 200, as Vapi expects', async () => {
    const res = await rig.tool('call-1', 'book_appointment', { slot: SLOT });
    assert.equal(res.status, 200);
    assert.equal(res.error, 'invalid arguments: name is required');
    assert.equal(rows(rig, 'select * from bookings').length, 0);
  });
});
