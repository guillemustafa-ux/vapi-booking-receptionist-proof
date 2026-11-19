/**
 * Cases found by the adversarial review before publishing (probes P1, P2a, P2b, P13 and the
 * hanging-Stripe minor), kept as regression tests.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CALLER } from './support/fake-vapi.js';
import { MONDAY, rows, startRig, type Rig } from './support/harness.js';

const SLOT = `${MONDAY}T10:00`;
const BEN = '+15555550999';
let rig: Rig;

describe('found by the review', () => {
  beforeEach(async () => {
    rig = await startRig();
  });
  afterEach(() => rig.close());

  it('P1: a released hold expires its Checkout Session first, so the old link cannot be paid', async () => {
    const ana = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    await rig.tool('call-1', 'send_deposit_link', { bookingRef: ana });
    const anaSession = rig.stripe.sessionIds()[0]!;
    rig.advanceMinutes(16);

    const ben = await rig.tool('call-2', 'book_appointment', { slot: SLOT, name: 'Ben Cole' }, { caller: BEN });
    assert.equal(ben.result!.status, 'booked');
    assert.equal(rig.stripe.status(anaSession), 'expired');
    assert.equal(rig.stripe.pay(anaSession), false);
    assert.deepEqual(rows(rig, `select status from deposits where booking_ref = ?`, ana), [{ status: 'expired' }]);
  });

  it('P1: cancelling expires the open link; a link paid before the cancel is flagged for a refund', async () => {
    const a = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    await rig.tool('call-1', 'send_deposit_link', { bookingRef: a });
    const [sessionA] = rig.stripe.sessionIds();
    assert.equal((await rig.tool('call-2', 'cancel_appointment', { bookingRef: a })).result!.status, 'cancelled');
    assert.equal(rig.stripe.pay(sessionA!), false);

    const b = (await rig.tool('call-3', 'book_appointment', { slot: `${MONDAY}T11:00`, name: 'Ana Ruiz' })).result!.bookingRef;
    await rig.tool('call-3', 'send_deposit_link', { bookingRef: b });
    rig.stripe.pay(rig.stripe.sessionIds()[1]!);
    const cancelled = await rig.tool('call-4', 'cancel_appointment', { bookingRef: b });
    assert.equal(cancelled.result!.depositRefund, 'handled by the front desk');
    assert.deepEqual(rows(rig, `select status from deposits where booking_ref = ?`, b), [{ status: 'paid' }]);
  });

  it('P1: with Stripe unreachable, a cancel changes nothing and asks to try again', async () => {
    const a = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    await rig.tool('call-1', 'send_deposit_link', { bookingRef: a });
    rig.stripe.goDark();
    assert.match((await rig.tool('call-2', 'cancel_appointment', { bookingRef: a })).error!, /not cancelled/);
    assert.deepEqual(rows(rig, 'select status from bookings'), [{ status: 'held' }]);
  });

  it('R1f: a cancel while the deposit link is still being created is refused, so no payable link outlives it', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    rig.stripe.delayNext(400);
    const link = rig.tool('call-1', 'send_deposit_link', { bookingRef: ref });
    await new Promise((r) => setTimeout(r, 100));
    const cancel = await rig.tool('call-2', 'cancel_appointment', { bookingRef: ref });
    assert.match(cancel.error!, /still being created/);
    assert.equal((await link).result!.status, 'link_sent');
    assert.deepEqual(rows(rig, 'select status from bookings'), [{ status: 'held' }]);
  });

  it('P2a: a spoken number in another format does not lock the calling line out of its booking', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz', phone: '(555) 555-0123' })).result!.bookingRef;
    assert.equal((await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref })).result!.status, 'link_sent');
    assert.deepEqual(rows(rig, 'select phone, callback_phone from bookings'), [{ phone: CALLER, callback_phone: '5555550123' }]);
  });

  it('P2b: the spoken number is a callback number, not the owner: that number cannot cancel', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz', phone: '+15555550777' })).result!.bookingRef;
    const other = await rig.tool('call-2', 'cancel_appointment', { bookingRef: ref }, { caller: '+15555550777' });
    assert.equal(other.result!.status, 'not_found');
    assert.equal((await rig.tool('call-3', 'cancel_appointment', { bookingRef: ref })).result!.status, 'cancelled');
  });

  it('P13: a call with the number withheld cannot book, and can still leave a message', async () => {
    const res = await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz', phone: '+15555550123' }, { caller: '' });
    assert.equal(res.result!.status, 'no_caller_id');
    assert.equal(rows(rig, 'select * from bookings').length, 0);
    const msg = await rig.tool('call-1', 'take_message', { name: 'Ana Ruiz', reason: 'book a cleaning', phone: '+15555550123' }, { caller: '' });
    assert.equal(msg.result!.status, 'message_taken');
  });

  it('a hanging Stripe cannot hold a request past Vapi\'s 20 s timeout', async () => {
    for (const [i, caller] of ['+15555550101', '+15555550102', '+15555550103', '+15555550104', '+15555550105', '+15555550106'].entries()) {
      const ref = (await rig.tool(`c${i}`, 'book_appointment', { slot: `${MONDAY}T1${i}:00`, name: `P${i}` }, { caller })).result!.bookingRef;
      await rig.tool(`c${i}`, 'send_deposit_link', { bookingRef: ref }, { caller });
    }
    rig.advanceMinutes(20);
    rig.stripe.hang();
    const started = Date.now();
    const faq = await rig.tool('call-9', 'lookup_faq', { topic: 'hours' });
    const elapsed = Date.now() - started;
    assert.equal(faq.result!.topic, 'hours');
    assert.ok(elapsed < 11_000, `took ${elapsed} ms`);
    assert.equal(rows(rig, `select * from bookings where status = 'held'`).length, 6);
  });
});
