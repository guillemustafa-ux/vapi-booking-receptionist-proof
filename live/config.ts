/**
 * What the live run creates in Vapi: the assistant (prompt, voice, the eight tools on the
 * receiver's Server URL) and the scenario the AI tester follows.
 */
import { DEFAULT_CLINIC } from '../src/clinic.js';

/** The next weekday at least two days ahead, as clinic-local YYYY-MM-DD. */
export function nextWorkday(now: Date): string {
  const local = new Date(now.getTime() + DEFAULT_CLINIC.utcOffsetMinutes * 60_000);
  for (let d = 2; ; d++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d));
    if (DEFAULT_CLINIC.workdays.includes(day.getUTCDay())) return day.toISOString().slice(0, 10);
  }
}

const str = (description: string) => ({ type: 'string', description });

const TOOLS = [
  ['check_availability', 'List the free appointment slots on a date.', { date: str('YYYY-MM-DD') }, ['date']],
  ['book_appointment', 'Book a slot and hold it for the deposit.', { slot: str('YYYY-MM-DDTHH:MM, clinic time'), name: str("The patient's full name"), phone: str('Optional callback number') }, ['slot', 'name']],
  ['reschedule_appointment', 'Move an existing booking.', { bookingRef: str('The booking code, e.g. BK-7Q2M9X'), newSlot: str('YYYY-MM-DDTHH:MM') }, ['bookingRef', 'newSlot']],
  ['cancel_appointment', 'Cancel a booking.', { bookingRef: str('The booking code') }, ['bookingRef']],
  ['send_deposit_link', 'Create the deposit payment link for a held booking.', { bookingRef: str('The booking code') }, ['bookingRef']],
  ['check_deposit', 'Check whether the deposit was paid.', { bookingRef: str('The booking code') }, ['bookingRef']],
  ['take_message', 'Take a message for the front desk.', { name: str('Caller name'), reason: str('What the call is about'), phone: str('Optional callback number') }, ['name', 'reason']],
  ['lookup_faq', 'Answer a common question. Topics: hours, insurance, parking.', { topic: str('hours, insurance or parking') }, ['topic']],
] as const;

export function assistantBody(serverUrl: string, credentialId: string, day: string): Record<string, unknown> {
  const server = { url: serverUrl, credentialId, timeoutSeconds: 20 };
  return {
    name: 'Bright Smile Dental receptionist (vapi-booking-receptionist-proof)',
    firstMessage: 'Thanks for calling Bright Smile Dental, this is the scheduling assistant. How can I help you today?',
    model: {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'system',
          content: [
            'You are the phone receptionist of Bright Smile Dental. Be brief and warm; one question at a time.',
            `Opening hours: Monday to Friday, 9 am to 5 pm, clinic time. Slots are 30 minutes. A suitable day to offer is ${day}.`,
            'To book: ask for the full name and the preferred time, call check_availability for the day, then book_appointment with slot as YYYY-MM-DDTHH:MM.',
            'A new booking is held for 15 minutes until a 50 dollar deposit is paid: offer send_deposit_link right after booking and read back the booking code, never the URL.',
            'If book_appointment answers slot_taken, offer the alternatives it returns. If it answers no_caller_id, offer to take a message.',
            'Answer questions about hours, insurance or parking with lookup_faq. Never invent prices, insurance plans or availability.',
            'When the caller is done, say goodbye and end the call.',
          ].join(' '),
        },
      ],
      tools: TOOLS.map(([name, description, properties, required]) => ({
        type: 'function',
        function: { name, description, parameters: { type: 'object', properties, required } },
        server,
      })),
    },
    voice: { provider: 'vapi', voiceId: 'Elliot' },
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
    server,
    endCallFunctionEnabled: true,
    maxDurationSeconds: 240,
    artifactPlan: { recordingEnabled: true },
  };
}

export function scenarioBody(day: string): Record<string, unknown> {
  return {
    name: 'Book a cleaning, get the deposit link, ask about insurance',
    instructions: [
      `You are Ana Ruiz calling Bright Smile Dental to book a teeth cleaning on ${day} at 10 am.`,
      'Give your name when asked. Accept the booking, ask for the deposit link, then ask whether they accept Delta Dental.',
      'When you have the booking code and the insurance answer, thank them and end the call. Do not invent other details.',
    ].join(' '),
    evaluations: [
      {
        structuredOutput: {
          name: 'booking_code_given',
          description: 'Return true only if the receptionist told the caller a booking code that starts with BK- and said a deposit link was sent or created. Otherwise false.',
          schema: { type: 'boolean' },
        },
        comparator: '=',
        value: true,
        required: true,
      },
    ],
  };
}
