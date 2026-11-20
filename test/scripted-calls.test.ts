/**
 * The client's grid, verbatim from the job post (S1):
 * «10 scripted test calls (booking, reschedule, cancel, double-booking attempt, paid deposit,
 * unpaid deposit, transfer, after-hours message, two FAQs)».
 *
 * Each call is the sequence of server messages Vapi would send for it, signed, over real HTTP.
 * Each test asserts what Vapi gets back, what the caller would be told, and the stored rows.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MONDAY, rows, startRig, type Rig } from './support/harness.js';

const OTHER_CALLER = '+15555550999';
let rig: Rig;

describe('the 10 scripted test calls', () => {
  beforeEach(async () => {
    rig = await startRig();
  });
  afterEach(() => rig.close());

  it('1. booking: checks the day, books a free slot, holds it for the deposit', async () => {
    const avail = await rig.tool('call-1', 'check_availability', { date: MONDAY });
    assert.equal(avail.status, 200);
    assert.ok((avail.result!.free as string[]).includes(`${MONDAY}T10:00`));

    const booked = await rig.tool('call-1', 'book_appointment', { slot: `${MONDAY}T10:00`, name: 'Ana Ruiz' });
    assert.equal(booked.result!.status, 'booked');
    assert.equal(booked.result!.bookingStatus, 'held');
    assert.match(booked.result!.bookingCode as string, /^BK-[A-Z2-9]{6}$/);
    assert.equal(booked.result!.depositCents, 5000);

    const after = await rig.tool('call-1', 'check_availability', { date: MONDAY });
    assert.ok(!(after.result!.free as string[]).includes(`${MONDAY}T10:00`));
    assert.equal(rows(rig, 'select * from bookings').length, 1);
  });

  it('2. reschedule: a later call moves the booking and frees the old slot', async () => {
    const booked = await rig.tool('call-1', 'book_appointment', { slot: `${MONDAY}T10:00`, name: 'Ana Ruiz' });
    const ref = booked.result!.bookingCode as string;

    const moved = await rig.tool('call-2', 'reschedule_appointment', { bookingCode: ref, newSlot: `${MONDAY}T11:30` });
    assert.equal(moved.result!.status, 'rescheduled');
    assert.equal(moved.result!.slot, `${MONDAY}T11:30`);
    assert.equal(moved.result!.previousSlot, `${MONDAY}T10:00`);

    const free = (await rig.tool('call-2', 'check_availability', { date: MONDAY })).result!.free as string[];
    assert.ok(free.includes(`${MONDAY}T10:00`));
    assert.ok(!free.includes(`${MONDAY}T11:30`));
    assert.deepEqual(rows(rig, 'select ref, slot from bookings'), [{ ref, slot: `${MONDAY}T11:30` }]);
  });

  it('3. cancel: frees the slot; cancelling again changes nothing', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: `${MONDAY}T10:00`, name: 'Ana Ruiz' })).result!.bookingCode;

    const cancelled = await rig.tool('call-2', 'cancel_appointment', { bookingCode: ref });
    assert.equal(cancelled.result!.status, 'cancelled');
    const again = await rig.tool('call-2', 'cancel_appointment', { bookingCode: ref });
    assert.equal(again.result!.status, 'already_cancelled');

    const free = (await rig.tool('call-2', 'check_availability', { date: MONDAY })).result!.free as string[];
    assert.ok(free.includes(`${MONDAY}T10:00`));
    assert.deepEqual(rows(rig, 'select status from bookings'), [{ status: 'cancelled' }]);
  });

  it('4. double-booking attempt: a second caller cannot take a held slot and gets alternatives', async () => {
    await rig.tool('call-1', 'book_appointment', { slot: `${MONDAY}T10:00`, name: 'Ana Ruiz' });

    const second = await rig.tool('call-2', 'book_appointment', { slot: `${MONDAY}T10:00`, name: 'Ben Cole' }, { caller: OTHER_CALLER });
    assert.equal(second.status, 200);
    assert.equal(second.result!.status, 'slot_taken');
    const alts = second.result!.alternatives as string[];
    assert.equal(alts.length, 3);
    assert.ok(!alts.includes(`${MONDAY}T10:00`));

    assert.deepEqual(rows(rig, `select name from bookings where slot = ? and status in ('held','confirmed')`, `${MONDAY}T10:00`), [
      { name: 'Ana Ruiz' },
    ]);
  });

  it('5. paid deposit: the link is created once and paying confirms the booking', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: `${MONDAY}T10:00`, name: 'Ana Ruiz' })).result!.bookingCode;

    const link = await rig.tool('call-1', 'send_deposit_link', { bookingCode: ref });
    assert.equal(link.result!.status, 'link_sent');
    assert.match(link.result!.url as string, /^https:\/\/checkout\.stripe\.com\//);
    assert.equal(rig.stripe.created, 1);

    rig.stripe.pay(rig.stripe.sessionIds()[0]!);
    const paid = await rig.tool('call-1', 'check_deposit', { bookingCode: ref });
    assert.equal(paid.result!.status, 'paid');
    assert.equal(paid.result!.bookingStatus, 'confirmed');

    rig.advanceMinutes(60); // past the 15-minute hold: a confirmed booking is not released
    await rig.tool('call-2', 'check_availability', { date: MONDAY });
    assert.deepEqual(rows(rig, 'select status from bookings'), [{ status: 'confirmed' }]);
    assert.deepEqual(rows(rig, 'select status from deposits'), [{ status: 'paid' }]);
  });

  it('6. unpaid deposit: the hold runs out and the slot goes back on sale', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: `${MONDAY}T10:00`, name: 'Ana Ruiz' })).result!.bookingCode;
    await rig.tool('call-1', 'send_deposit_link', { bookingCode: ref });

    const unpaid = await rig.tool('call-1', 'check_deposit', { bookingCode: ref });
    assert.equal(unpaid.result!.status, 'unpaid');
    assert.ok(unpaid.result!.holdExpiresAt);

    rig.advanceMinutes(16);
    const second = await rig.tool('call-2', 'book_appointment', { slot: `${MONDAY}T10:00`, name: 'Ben Cole' }, { caller: OTHER_CALLER });
    assert.equal(second.result!.status, 'booked');

    const late = await rig.tool('call-3', 'check_deposit', { bookingCode: ref });
    assert.equal(late.result!.status, 'hold_expired');
    assert.deepEqual(rows(rig, 'select name, status from bookings order by created_at, name'), [
      { name: 'Ana Ruiz', status: 'expired' },
      { name: 'Ben Cole', status: 'held' },
    ]);
  });

  it('7. transfer: during opening hours the call goes to the front desk', async () => {
    const res = await rig.transfer('call-1');
    assert.deepEqual(res, {
      status: 200,
      json: {
        destination: { type: 'number', number: '+15550100200' },
        message: { type: 'request-start', message: 'Transferring you to the front desk now.' },
      },
    });
  });

  it('8. after-hours message: the transfer is refused and one message is taken', async () => {
    rig.setNow(new Date('2026-11-20T23:30:00Z')); // 18:30 at the clinic
    const res = await rig.transfer('call-1');
    assert.deepEqual(res, { status: 200, json: { error: 'The office is closed. Offer to take a message.' } });

    const msg = await rig.tool('call-1', 'take_message', { name: 'Ana Ruiz', reason: 'Tooth pain since yesterday' });
    assert.equal(msg.result!.status, 'message_taken');
    assert.equal(msg.result!.callbackNumber, '+15555550123');
    await rig.tool('call-1', 'take_message', { name: 'Ana Ruiz', reason: 'Tooth pain since yesterday' });
    assert.equal(rows(rig, 'select * from messages').length, 1);
  });

  it('9. FAQ: opening hours', async () => {
    const faq = await rig.tool('call-1', 'lookup_faq', { topic: 'hours' });
    assert.deepEqual(faq.result, { topic: 'hours', answer: 'We are open Monday to Friday, 9 am to 5 pm.' });
  });

  it('10. FAQ: insurance', async () => {
    const faq = await rig.tool('call-1', 'lookup_faq', { topic: 'Insurance' });
    assert.equal(faq.result!.topic, 'insurance');
    assert.match(faq.result!.answer as string, /Delta Dental/);
  });
});
