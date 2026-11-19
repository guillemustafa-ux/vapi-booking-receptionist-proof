import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { checkSlot, DEFAULT_CLINIC, isOpen, normalizePhone, slotsOn, type Clinic } from '../clinic.js';
import { crashIfAt, type CrashPoint } from '../crash.js';
import type { Receptionist } from '../receptionist.js';
import { StripeError, type CheckoutSession, type StripeClient } from '../stripe.js';
import { toolArguments, type ToolCall, type ToolResult, type TransferResponse, type VapiCall } from '../vapi.js';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export interface ReceptionistOptions {
  dbPath: string;
  stripe: StripeClient;
  clinic?: Clinic;
  now?: () => Date;
  fault?: CrashPoint;
}

/** What a tool produced: spoken back by the assistant (`result`) or reported as a failure (`error`). */
type Outcome = { result: Record<string, unknown> } | { error: string };

interface BookingRow {
  ref: string;
  vapi_call_id: string;
  phone: string;
  name: string;
  slot: string;
  status: 'held' | 'confirmed' | 'cancelled' | 'expired';
  hold_expires_at: string | null;
}

interface DepositRow {
  booking_ref: string;
  idempotency_key: string;
  status: 'creating' | 'open' | 'paid' | 'expired' | 'failed' | 'unknown';
  session_id: string | null;
  url: string | null;
  created_at: string;
}

class ArgError extends Error {}

const LIVE = `status in ('held', 'confirmed')`;

/** Expired holds are checked with Stripe at the start of a request, within this much real time. */
export const SWEEP_BUDGET_MS = 6_000;
const SWEEP_CALL_TIMEOUT_MS = 2_500;
/** Stripe keeps idempotency keys for at least 24 hours; past that, a retry with the old key is unsafe. */
const KEY_SAFE_RETRY_MS = 23 * 60 * 60 * 1000;
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: read aloud on a call

/**
 * The guarded receptionist. Per tool call:
 *
 *   1. tool_calls row keyed by the Vapi tool call id, written before the tool runs; a redelivery
 *      of a finished call answers the stored outcome and runs nothing
 *   2. a booking tool writes its rows and finishes the tool call in ONE transaction
 *   3. business keys hold even when the model re-calls a tool with a NEW id: one live booking per
 *      slot and per call (unique indexes), one deposit per booking (Stripe Idempotency-Key)
 *   4. a held booking whose hold ran out is released only after Stripe says it is unpaid
 */
export function createHonestReceptionist(opts: ReceptionistOptions): Receptionist {
  const db = new Database(opts.dbPath);
  db.exec(SCHEMA);
  const clinic = opts.clinic ?? DEFAULT_CLINIC;
  const now = opts.now ?? (() => new Date());
  const iso = () => now().toISOString();
  /** Deposits whose Stripe request is in flight in THIS process. */
  const inFlight = new Set<string>();

  /** Synchronous: committed before the tool runs. Returns the stored outcome of a finished call. */
  const recordToolCall = db.transaction((call: VapiCall, tc: ToolCall): Outcome | undefined => {
    const inserted =
      db
        .prepare(
          `insert into tool_calls (tool_call_id, vapi_call_id, name, args_json, status, first_seen_at)
           values (?, ?, ?, ?, 'started', ?) on conflict (tool_call_id) do nothing`,
        )
        .run(tc.id, call.id, tc.function.name, JSON.stringify(tc.function.arguments ?? {}), iso()).changes === 1;
    if (inserted) return undefined;
    db.prepare('update tool_calls set deliveries = deliveries + 1 where tool_call_id = ?').run(tc.id);
    const row = db.prepare('select status, outcome_json from tool_calls where tool_call_id = ?').get(tc.id) as {
      status: string;
      outcome_json: string | null;
    };
    // `started`: a dead process, or this process still on it. Every tool is idempotent on its
    // business key, so running it again cannot duplicate anything.
    return row.status === 'done' && row.outcome_json ? (JSON.parse(row.outcome_json) as Outcome) : undefined;
  });

  function finish(toolCallId: string, outcome: Outcome): void {
    db.prepare(`update tool_calls set status = 'done', outcome_json = ?, finished_at = ? where tool_call_id = ?`).run(
      JSON.stringify(outcome),
      iso(),
      toolCallId,
    );
  }

  // ---- arguments ---------------------------------------------------------------------------

  function str(args: Record<string, unknown>, key: string, required = true): string | undefined {
    const v = args[key];
    if (v === undefined || v === null || v === '') {
      if (required) throw new ArgError(`${key} is required`);
      return undefined;
    }
    if (typeof v !== 'string') throw new ArgError(`${key} must be a string`);
    return v.trim();
  }

  /** Caller ID as Vapi saw it on the line, or undefined when the number is withheld. */
  function lineNumber(call: VapiCall): string | undefined {
    const n = call.customer?.number ? normalizePhone(call.customer.number) : '';
    return n.replace('+', '').length >= 7 ? n : undefined;
  }

  /** A callback number: the one the caller said, else the line. Contact data, never proof of ownership. */
  function callbackPhone(call: VapiCall, args: Record<string, unknown>): string {
    const said = str(args, 'phone', false);
    const phone = said ? normalizePhone(said) : lineNumber(call);
    if (!phone || phone.replace('+', '').length < 7) throw new ArgError('phone is required');
    return phone;
  }

  // ---- bookings ----------------------------------------------------------------------------

  function newRef(): string {
    let s = 'BK-';
    for (let i = 0; i < 6; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
    return s;
  }

  function liveSlots(): Set<string> {
    return new Set((db.prepare(`select slot from bookings where ${LIVE}`).all() as { slot: string }[]).map((r) => r.slot));
  }

  /** The next free slots from `fromDate` on, up to `count`, looking ahead two weeks. */
  function alternatives(fromDate: string, count = 3): string[] {
    const taken = liveSlots();
    const out: string[] = [];
    const start = Date.parse(`${fromDate}T00:00:00Z`);
    for (let d = 0; d < 14 && out.length < count; d++) {
      const date = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
      for (const slot of slotsOn(clinic, date)) {
        if (out.length >= count) break;
        if (!taken.has(slot) && checkSlot(clinic, slot, now()) === 'ok') out.push(slot);
      }
    }
    return out;
  }

  /**
   * A booking the caller may act on: the ref must exist AND belong to the number on the line
   * (`call.customer.number`, as Vapi saw it). A number the caller says is never proof of
   * ownership; a call without caller ID cannot book, move or cancel, only leave a message.
   */
  function ownedBooking(ref: string, call: VapiCall): BookingRow | undefined {
    const line = lineNumber(call);
    if (!line) return undefined;
    const b = db.prepare('select * from bookings where ref = ?').get(ref.toUpperCase()) as BookingRow | undefined;
    return b && b.phone === line ? b : undefined;
  }

  function isUniqueViolation(err: unknown): boolean {
    return err instanceof Error && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
  }

  function bookingResult(b: BookingRow, status: string): Record<string, unknown> {
    return {
      status,
      bookingRef: b.ref,
      slot: b.slot,
      name: b.name,
      bookingStatus: b.status,
      ...(b.status === 'held' ? { depositCents: clinic.depositCents, holdExpiresAt: b.hold_expires_at } : {}),
    };
  }

  function checkAvailability(args: Record<string, unknown>): Outcome {
    const date = str(args, 'date')!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ArgError('date must be YYYY-MM-DD');
    const taken = liveSlots();
    const free = slotsOn(clinic, date).filter((s) => !taken.has(s) && checkSlot(clinic, s, now()) === 'ok');
    return { result: { date, free } };
  }

  function book(call: VapiCall, args: Record<string, unknown>): Outcome {
    const slot = str(args, 'slot')!;
    const name = str(args, 'name')!;
    const owner = lineNumber(call);
    // Without caller ID nobody could later prove the booking is theirs: offer a message instead.
    if (!owner) return { result: { status: 'no_caller_id', hint: 'take a message or transfer to the front desk' } };
    const callback = callbackPhone(call, args);
    const check = checkSlot(clinic, slot, now());
    if (check !== 'ok') return { result: { status: check, slot } };

    const mine = db.prepare(`select * from bookings where vapi_call_id = ? and ${LIVE}`).get(call.id) as BookingRow | undefined;
    if (mine) {
      // The model re-sent the booking (new tool call id, same call): same slot = the same booking.
      return mine.slot === slot
        ? { result: bookingResult(mine, 'booked') }
        : { result: { ...bookingResult(mine, 'already_booked'), hint: 'use reschedule_appointment to move it' } };
    }

    const ref = newRef();
    const t = iso();
    const holdExpiresAt = new Date(now().getTime() + clinic.holdMinutes * 60_000).toISOString();
    try {
      db.prepare(
        `insert into bookings (ref, vapi_call_id, phone, callback_phone, name, slot, status, hold_expires_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?)`,
      ).run(ref, call.id, owner, callback, name, slot, holdExpiresAt, t, t);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return { result: { status: 'slot_taken', slot, alternatives: alternatives(slot.slice(0, 10)) } };
    }
    return { result: bookingResult(db.prepare('select * from bookings where ref = ?').get(ref) as BookingRow, 'booked') };
  }

  function reschedule(call: VapiCall, args: Record<string, unknown>): Outcome {
    const ref = str(args, 'bookingRef')!;
    const newSlot = str(args, 'newSlot')!;
    const b = ownedBooking(ref, call);
    if (!b || (b.status !== 'held' && b.status !== 'confirmed')) return { result: { status: 'not_found', bookingRef: ref } };
    if (b.slot === newSlot) return { result: bookingResult(b, 'unchanged') };
    const check = checkSlot(clinic, newSlot, now());
    if (check !== 'ok') return { result: { status: check, slot: newSlot } };
    try {
      db.prepare('update bookings set slot = ?, updated_at = ? where ref = ?').run(newSlot, iso(), b.ref);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return { result: { status: 'slot_taken', slot: newSlot, alternatives: alternatives(newSlot.slice(0, 10)) } };
    }
    const moved = db.prepare('select * from bookings where ref = ?').get(b.ref) as BookingRow;
    return { result: { ...bookingResult(moved, 'rescheduled'), previousSlot: b.slot } };
  }

  /**
   * Cancelling a held booking first expires its open Checkout Session, so the link cannot be
   * paid afterwards. A session Stripe says is already paid is recorded and flagged for a refund.
   * If Stripe cannot be asked, nothing is cancelled and the caller is asked to try again.
   */
  async function cancel(call: VapiCall, args: Record<string, unknown>): Promise<Outcome> {
    const ref = str(args, 'bookingRef')!;
    const b = ownedBooking(ref, call);
    if (!b) return { result: { status: 'not_found', bookingRef: ref } };
    if (b.status === 'cancelled') return { result: { status: 'already_cancelled', bookingRef: b.ref } };
    if (b.status === 'expired') return { result: { status: 'already_released', bookingRef: b.ref } };
    const dep = db.prepare('select * from deposits where booking_ref = ?').get(b.ref) as DepositRow | undefined;
    let paid = dep?.status === 'paid';
    if (dep?.session_id && dep.status === 'open') {
      const closed = await closeSession(dep.session_id);
      if (closed === 'unknown') return { error: 'The payment system did not answer, so the booking was not cancelled. Offer to try again.' };
      if (closed === 'paid') {
        confirmPaid(b.ref);
        paid = true;
      } else setDeposit(b.ref, 'expired');
    }
    db.prepare(`update bookings set status = 'cancelled', hold_expires_at = null, updated_at = ? where ref = ?`).run(iso(), b.ref);
    return { result: { status: 'cancelled', bookingRef: b.ref, slot: b.slot, ...(paid ? { depositRefund: 'handled by the front desk' } : {}) } };
  }

  function takeMessage(call: VapiCall, args: Record<string, unknown>): Outcome {
    const name = str(args, 'name')!;
    const reason = str(args, 'reason')!;
    const phone = callbackPhone(call, args);
    db.prepare(
      `insert into messages (vapi_call_id, name, phone, reason, created_at) values (?, ?, ?, ?, ?)
       on conflict (vapi_call_id) do nothing`,
    ).run(call.id, name, phone, reason, iso());
    return { result: { status: 'message_taken', callbackNumber: phone } };
  }

  function lookupFaq(args: Record<string, unknown>): Outcome {
    const topic = str(args, 'topic')!.toLowerCase();
    const answer = clinic.faqs[topic];
    return answer ? { result: { topic, answer } } : { result: { status: 'unknown_topic', topics: Object.keys(clinic.faqs) } };
  }

  const SYNC_TOOLS: Record<string, (call: VapiCall, args: Record<string, unknown>) => Outcome> = {
    check_availability: (_c, a) => checkAvailability(a),
    book_appointment: book,
    reschedule_appointment: reschedule,
    take_message: takeMessage,
    lookup_faq: (_c, a) => lookupFaq(a),
  };

  // ---- deposits ----------------------------------------------------------------------------

  function setDeposit(ref: string, status: DepositRow['status']): void {
    db.prepare('update deposits set status = ?, updated_at = ? where booking_ref = ?').run(status, iso(), ref);
  }

  /**
   * Makes an open Checkout Session unpayable. `expired`: Stripe expired it (or it already was).
   * `paid`: it was paid before it could be expired. `unknown`: Stripe could not be asked.
   */
  async function closeSession(id: string, timeoutMs?: number): Promise<'expired' | 'paid' | 'unknown'> {
    const read = (x: CheckoutSession) => (x.payment_status === 'paid' ? 'paid' : x.status === 'expired' ? 'expired' : 'unknown');
    try {
      return read(await opts.stripe.expireSession(id, timeoutMs));
    } catch (err) {
      if (!(err instanceof StripeError)) throw err;
      if (err.outcome === 'unknown') return 'unknown';
    }
    try {
      return read(await opts.stripe.getSession(id, timeoutMs)); // refused: it was not open any more
    } catch (err) {
      if (err instanceof StripeError) return 'unknown';
      throw err;
    }
  }

  const confirmPaid = db.transaction((ref: string) => {
    const t = iso();
    db.prepare(`update bookings set status = 'confirmed', hold_expires_at = null, updated_at = ? where ref = ? and status = 'held'`).run(t, ref);
    db.prepare(`update deposits set status = 'paid', updated_at = ? where booking_ref = ?`).run(t, ref);
  });

  async function sendDepositLink(call: VapiCall, args: Record<string, unknown>): Promise<Outcome> {
    const ref = str(args, 'bookingRef')!;
    const b = ownedBooking(ref, call);
    if (!b || (b.status !== 'held' && b.status !== 'confirmed')) return { result: { status: 'not_found', bookingRef: ref } };
    if (b.status === 'confirmed') return { result: { status: 'already_paid', bookingRef: b.ref } };

    const key = `deposit-${b.ref}`;
    const t = iso();
    db.prepare(
      `insert into deposits (booking_ref, idempotency_key, status, created_at, updated_at) values (?, ?, 'creating', ?, ?)
       on conflict (booking_ref) do nothing`,
    ).run(b.ref, key, t, t);
    const dep = db.prepare('select * from deposits where booking_ref = ?').get(b.ref) as DepositRow;
    if (dep.status === 'open' || dep.status === 'paid') return { result: { status: 'link_sent', bookingRef: b.ref, url: dep.url } };
    if (inFlight.has(b.ref)) return { result: { status: 'pending', bookingRef: b.ref } };
    if (dep.status === 'unknown' && now().getTime() - Date.parse(dep.created_at) > KEY_SAFE_RETRY_MS) {
      // Stripe may have pruned the key: a retry could create a second session. A person decides.
      return { error: 'The deposit link needs the front desk to check it. Offer to transfer or take a message.' };
    }

    // `creating` left by a dead process, `unknown` or `failed`: send again with the SAME key.
    inFlight.add(b.ref);
    try {
      db.prepare(`update deposits set status = 'creating', error = null, updated_at = ? where booking_ref = ?`).run(iso(), b.ref);
      const session = await opts.stripe.createDepositSession(
        { bookingRef: b.ref, amountCents: clinic.depositCents, currency: clinic.currency, successUrl: clinic.depositSuccessUrl },
        key,
      );
      crashIfAt(opts.fault, 'after_stripe');
      db.prepare(`update deposits set status = 'open', session_id = ?, url = ?, updated_at = ? where booking_ref = ?`).run(
        session.id,
        session.url,
        iso(),
        b.ref,
      );
      return { result: { status: 'link_sent', bookingRef: b.ref, url: session.url } };
    } catch (err) {
      if (!(err instanceof StripeError)) throw err;
      db.prepare(`update deposits set status = ?, error = ?, updated_at = ? where booking_ref = ?`).run(
        err.outcome === 'unknown' ? 'unknown' : 'failed',
        err.message,
        iso(),
        b.ref,
      );
      return { error: 'The payment system did not confirm the deposit link. Offer to try again in a moment.' };
    } finally {
      inFlight.delete(b.ref);
    }
  }

  async function checkDeposit(call: VapiCall, args: Record<string, unknown>): Promise<Outcome> {
    const ref = str(args, 'bookingRef')!;
    const b = ownedBooking(ref, call);
    if (!b) return { result: { status: 'not_found', bookingRef: ref } };
    if (b.status === 'confirmed') return { result: bookingResult(b, 'paid') };
    if (b.status !== 'held') return { result: { status: b.status === 'expired' ? 'hold_expired' : 'cancelled', bookingRef: b.ref } };
    const dep = db.prepare('select * from deposits where booking_ref = ?').get(b.ref) as DepositRow | undefined;
    if (!dep?.session_id) return { result: { status: 'no_link', bookingRef: b.ref } };
    try {
      const session = await opts.stripe.getSession(dep.session_id);
      if (session.payment_status === 'paid') {
        confirmPaid(b.ref);
        return { result: bookingResult(db.prepare('select * from bookings where ref = ?').get(b.ref) as BookingRow, 'paid') };
      }
      return { result: bookingResult(b, 'unpaid') };
    } catch (err) {
      if (!(err instanceof StripeError)) throw err;
      return { error: 'The payment system did not answer. Offer to check again in a moment.' };
    }
  }

  /**
   * Holds past their expiry are released only after their Checkout Session is expired at Stripe,
   * so a released slot's link can no longer be paid. A session Stripe says is paid confirms the
   * booking instead. If Stripe cannot be asked, or a session may exist that cannot be looked up,
   * the hold stays. The sweep stops after SWEEP_BUDGET_MS of real time so a hanging Stripe cannot
   * push the request past Vapi's 20 s timeout; what is left is swept on a later request.
   */
  async function releaseExpiredHolds(): Promise<void> {
    const started = Date.now();
    const due = db.prepare(`select * from bookings where status = 'held' and hold_expires_at <= ?`).all(iso()) as BookingRow[];
    for (const b of due) {
      if (Date.now() - started > SWEEP_BUDGET_MS) break;
      const dep = db.prepare('select * from deposits where booking_ref = ?').get(b.ref) as DepositRow | undefined;
      if (dep && !dep.session_id && dep.status !== 'failed') continue; // a session may exist that we cannot look up
      if (dep?.session_id && dep.status === 'open') {
        const closed = await closeSession(dep.session_id, SWEEP_CALL_TIMEOUT_MS);
        if (closed === 'paid') {
          confirmPaid(b.ref);
          continue;
        }
        if (closed === 'unknown') continue;
        setDeposit(b.ref, 'expired');
      }
      db.prepare(`update bookings set status = 'expired', updated_at = ? where ref = ? and status = 'held'`).run(iso(), b.ref);
    }
  }

  // ---- dispatch ----------------------------------------------------------------------------

  async function runOne(call: VapiCall, tc: ToolCall): Promise<ToolResult> {
    const name = tc.function.name;
    const answer = (o: Outcome): ToolResult =>
      'error' in o ? { name, toolCallId: tc.id, error: o.error } : { name, toolCallId: tc.id, result: JSON.stringify(o.result) };

    const stored = recordToolCall(call, tc);
    if (stored) return answer(stored);

    let args: Record<string, unknown>;
    try {
      args = toolArguments(tc);
    } catch (err) {
      const o = { error: `invalid arguments: ${err instanceof Error ? err.message : String(err)}` };
      finish(tc.id, o);
      return answer(o);
    }

    const sync = SYNC_TOOLS[name];
    let outcome: Outcome;
    try {
      if (sync) {
        // The tool's rows and the finished tool call: one transaction.
        outcome = db.transaction(() => {
          const o = sync(call, args);
          finish(tc.id, o);
          return o;
        })();
        if (name === 'book_appointment' && 'result' in outcome && outcome.result.status === 'booked') crashIfAt(opts.fault, 'after_booking');
        return answer(outcome);
      }
      if (name === 'cancel_appointment') outcome = await cancel(call, args);
      else if (name === 'send_deposit_link') outcome = await sendDepositLink(call, args);
      else if (name === 'check_deposit') outcome = await checkDeposit(call, args);
      else outcome = { error: `unknown tool: ${name}` };
    } catch (err) {
      if (!(err instanceof ArgError)) throw err;
      outcome = { error: `invalid arguments: ${err.message}` };
    }
    finish(tc.id, outcome);
    return answer(outcome);
  }

  return {
    async handleToolCalls(call, toolCalls) {
      await releaseExpiredHolds();
      const out: ToolResult[] = [];
      for (const tc of toolCalls) out.push(await runOne(call, tc));
      return out;
    },
    transferDestination(): TransferResponse {
      return isOpen(clinic, now())
        ? {
            destination: { type: 'number', number: clinic.frontDeskNumber },
            message: { type: 'request-start', message: 'Transferring you to the front desk now.' },
          }
        : { error: 'The office is closed. Offer to take a message.' };
    },
    close: () => db.close(),
  };
}
