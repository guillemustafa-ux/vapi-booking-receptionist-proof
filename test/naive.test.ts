/**
 * The naive receptionist (src/naive/) on the same calls, for contrast: these tests pass because
 * the naive side DOES duplicate. Each one is a guarantee the honest side keeps (duplicates.test.ts).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createNaiveReceptionist } from '../src/naive/receptionist.js';
import { MONDAY, rows, startRig, type Rig } from './support/harness.js';

const SLOT = `${MONDAY}T10:00`;
let rig: Rig;

describe('naive side: what the guards prevent', () => {
  beforeEach(async () => {
    rig = await startRig((o) => createNaiveReceptionist(o));
  });
  afterEach(() => rig.close());

  it('naive: the model re-calling send_deposit_link creates a second Checkout Session', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref });
    await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref });
    assert.equal(rig.stripe.created, 2);
  });

  it('naive: a late redelivery after the caller cancelled books the slot again', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' }, { id: 'tc-book' })).result!.bookingRef;
    await rig.tool('call-1', 'cancel_appointment', { bookingRef: ref });
    await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' }, { id: 'tc-book' });
    assert.deepEqual(rows(rig, 'select status from bookings order by rowid'), [{ status: 'cancelled' }, { status: 'booked' }]);
  });

  it('naive: a retry after a lost Stripe answer creates a second Checkout Session', async () => {
    const ref = (await rig.tool('call-1', 'book_appointment', { slot: SLOT, name: 'Ana Ruiz' })).result!.bookingRef;
    rig.stripe.failNext('drop');
    assert.equal((await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref })).status, 500);
    await rig.tool('call-1', 'send_deposit_link', { bookingRef: ref });
    assert.equal(rig.stripe.created, 2);
  });
});
