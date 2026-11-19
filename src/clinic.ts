/**
 * The clinic: opening hours, the slot grid and the FAQ answers. Times are clinic-local wall
 * clock strings `YYYY-MM-DDTHH:MM` at a fixed UTC offset (no DST handling: a stated limit).
 */
export interface Clinic {
  name: string;
  /** Clinic local time = UTC + this many minutes (-300 = UTC-5). */
  utcOffsetMinutes: number;
  openMinute: number;
  closeMinute: number;
  /** Local weekdays the clinic opens, 0 = Sunday. */
  workdays: number[];
  slotMinutes: number;
  /** Where a caller is transferred during opening hours. */
  frontDeskNumber: string;
  /** How long a booking is held while its deposit is unpaid. */
  holdMinutes: number;
  depositCents: number;
  currency: string;
  faqs: Record<string, string>;
}

export const DEFAULT_CLINIC: Clinic = {
  name: 'Bright Smile Dental',
  utcOffsetMinutes: -300,
  openMinute: 9 * 60,
  closeMinute: 17 * 60,
  workdays: [1, 2, 3, 4, 5],
  slotMinutes: 30,
  frontDeskNumber: '+15550100200',
  holdMinutes: 15,
  depositCents: 5000,
  currency: 'usd',
  faqs: {
    hours: 'We are open Monday to Friday, 9 am to 5 pm.',
    insurance: 'We accept Delta Dental, Cigna and Aetna PPO plans; bring your card to the visit.',
    parking: 'Free parking is behind the building.',
  },
};

const SLOT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A Date shifted so its UTC getters read clinic-local wall clock. */
function local(clinic: Clinic, at: Date): Date {
  return new Date(at.getTime() + clinic.utcOffsetMinutes * 60_000);
}

export function isOpen(clinic: Clinic, now: Date): boolean {
  const l = local(clinic, now);
  const minute = l.getUTCHours() * 60 + l.getUTCMinutes();
  return clinic.workdays.includes(l.getUTCDay()) && minute >= clinic.openMinute && minute < clinic.closeMinute;
}

/** The instant a local slot string starts, or undefined when it is not a valid calendar slot string. */
export function slotStart(clinic: Clinic, slot: string): Date | undefined {
  const m = SLOT_RE.exec(slot);
  if (!m) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(ms);
  // Rejects 2026-02-30 and 25:00, which Date.UTC would silently roll over.
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h) return undefined;
  return new Date(ms - clinic.utcOffsetMinutes * 60_000);
}

export type SlotCheck = 'ok' | 'invalid_slot' | 'outside_hours' | 'in_the_past';

/** A bookable slot: on the grid, a working day, inside opening hours, and not started yet. */
export function checkSlot(clinic: Clinic, slot: string, now: Date): SlotCheck {
  const start = slotStart(clinic, slot);
  if (!start) return 'invalid_slot';
  const l = local(clinic, start);
  const minute = l.getUTCHours() * 60 + l.getUTCMinutes();
  if (minute % clinic.slotMinutes !== 0) return 'invalid_slot';
  if (!clinic.workdays.includes(l.getUTCDay())) return 'outside_hours';
  if (minute < clinic.openMinute || minute + clinic.slotMinutes > clinic.closeMinute) return 'outside_hours';
  if (start.getTime() <= now.getTime()) return 'in_the_past';
  return 'ok';
}

/** Every slot of a local date, in order; empty for a malformed date or a closed day. */
export function slotsOn(clinic: Clinic, date: string): string[] {
  if (!DATE_RE.test(date) || !slotStart(clinic, `${date}T00:00`)) return [];
  const out: string[] = [];
  for (let m = clinic.openMinute; m + clinic.slotMinutes <= clinic.closeMinute; m += clinic.slotMinutes) {
    const slot = `${date}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    if (checkSlot(clinic, slot, new Date(0)) === 'ok') out.push(slot);
  }
  return out;
}

/** Digits with a leading `+` kept; what the caller says and what Vapi sends compare equal. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  return raw.trim().startsWith('+') ? `+${digits}` : digits;
}
