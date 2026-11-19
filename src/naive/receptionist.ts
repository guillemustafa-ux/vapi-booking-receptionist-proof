import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { checkSlot, DEFAULT_CLINIC, isOpen, normalizePhone, slotsOn } from '../clinic.js';
import type { ReceptionistOptions } from '../honest/receptionist.js';
import type { Receptionist } from '../receptionist.js';
import { toolArguments, type ToolCall, type ToolResult, type VapiCall } from '../vapi.js';

/**
 * The receptionist as it is usually first written, kept for contrast: every tool call runs,
 * a booking is a read-then-insert, a deposit link is a new Checkout Session each time, and a
 * hold never runs out. Each of these is a test that fails on this side (test/naive.test.ts).
 */
export function createNaiveReceptionist(opts: ReceptionistOptions): Receptionist {
  const db = new Database(opts.dbPath);
  db.exec(`
    create table if not exists bookings (ref text primary key, vapi_call_id text, phone text, name text, slot text, status text, created_at text);
    create table if not exists deposits (booking_ref text, session_id text, url text);
    create table if not exists messages (vapi_call_id text, name text, phone text, reason text, created_at text);
  `);
  const clinic = opts.clinic ?? DEFAULT_CLINIC;
  const now = opts.now ?? (() => new Date());

  async function run(call: VapiCall, name: string, args: Record<string, any>): Promise<Record<string, unknown>> {
    const phone = normalizePhone(String(args.phone ?? call.customer?.number ?? ''));
    switch (name) {
      case 'check_availability': {
        const taken = new Set((db.prepare(`select slot from bookings where status = 'booked'`).all() as { slot: string }[]).map((r) => r.slot));
        return { date: args.date, free: slotsOn(clinic, args.date).filter((s) => !taken.has(s) && checkSlot(clinic, s, now()) === 'ok') };
      }
      case 'book_appointment': {
        const taken = db.prepare(`select 1 from bookings where slot = ? and status = 'booked'`).get(args.slot);
        if (taken) return { status: 'slot_taken', slot: args.slot };
        const ref = `BK-${randomUUID().slice(0, 6).toUpperCase()}`;
        db.prepare(`insert into bookings values (?, ?, ?, ?, ?, 'booked', ?)`).run(ref, call.id, phone, args.name, args.slot, now().toISOString());
        return { status: 'booked', bookingRef: ref, slot: args.slot, name: args.name };
      }
      case 'reschedule_appointment':
        db.prepare('update bookings set slot = ? where ref = ?').run(args.newSlot, args.bookingRef);
        return { status: 'rescheduled', bookingRef: args.bookingRef, slot: args.newSlot };
      case 'cancel_appointment':
        db.prepare(`update bookings set status = 'cancelled' where ref = ?`).run(args.bookingRef);
        return { status: 'cancelled', bookingRef: args.bookingRef };
      case 'send_deposit_link': {
        const s = await opts.stripe.createDepositSession(
          { bookingRef: args.bookingRef, amountCents: clinic.depositCents, currency: clinic.currency },
          randomUUID(), // a fresh key per request: the same as sending none
        );
        db.prepare('insert into deposits values (?, ?, ?)').run(args.bookingRef, s.id, s.url);
        return { status: 'link_sent', bookingRef: args.bookingRef, url: s.url };
      }
      case 'check_deposit': {
        const d = db.prepare('select session_id from deposits where booking_ref = ? order by rowid desc').get(args.bookingRef) as
          | { session_id: string }
          | undefined;
        if (!d) return { status: 'no_link' };
        return { status: (await opts.stripe.getSession(d.session_id)).payment_status, bookingRef: args.bookingRef };
      }
      case 'take_message':
        db.prepare('insert into messages values (?, ?, ?, ?, ?)').run(call.id, args.name, phone, args.reason, now().toISOString());
        return { status: 'message_taken', callbackNumber: phone };
      case 'lookup_faq':
        return { topic: args.topic, answer: clinic.faqs[String(args.topic).toLowerCase()] ?? 'unknown' };
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  return {
    async handleToolCalls(call: VapiCall, toolCalls: ToolCall[]): Promise<ToolResult[]> {
      const out: ToolResult[] = [];
      for (const tc of toolCalls) {
        const result = await run(call, tc.function.name, toolArguments(tc));
        out.push({ name: tc.function.name, toolCallId: tc.id, result: JSON.stringify(result) });
      }
      return out;
    },
    transferDestination: () =>
      isOpen(clinic, now())
        ? { destination: { type: 'number', number: clinic.frontDeskNumber }, message: { type: 'request-start', message: 'Transferring you now.' } }
        : { error: 'The office is closed. Offer to take a message.' },
    close: () => db.close(),
  };
}
