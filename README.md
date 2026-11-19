# vapi-booking-receptionist-proof

The Server URL of a dental-clinic voice receptionist on Vapi, in Node + TypeScript with SQLite.
It shows that **a phone call cannot book a slot twice, double-book it, or create two deposits**,
even when Vapi redelivers a tool call, the model calls the same tool again after a slow answer,
two callers race for one slot, Stripe loses an answer, or the receiver is killed mid-request.

Tested offline, over real HTTP: a fake Vapi that signs requests the way Vapi's HMAC credential
does, a fake Stripe with Stripe's documented idempotency behaviour, and a receiver process killed
with `SIGKILL`. No Vapi account, no phone call and no real Stripe were used (see [Limits](#limits)).

| The ask | Where it is covered |
| --- | --- |
| «10 scripted test calls (booking, reschedule, cancel, double-booking attempt, paid deposit, unpaid deposit, transfer, after-hours message, two FAQs)» | [`test/scripted-calls.test.ts`](test/scripted-calls.test.ts): one test per call, in that order |
| "AI Receptionist with Booking & Stripe Deposits" | booking with a 15-minute hold, a Stripe Checkout deposit link, paid confirms, unpaid releases |
| no duplicate bookings or charges when a call goes wrong | [`test/duplicates.test.ts`](test/duplicates.test.ts), [`test/crash.test.ts`](test/crash.test.ts) |

## What it proves

A tool call on a live phone call can run more than once without anyone asking twice:

- **Vapi redelivers it** with the same `toolCallId` when a `backoffPlan` is set (Vapi's tool
  timeout defaults to 20 seconds), or someone replays a captured signed request.
- **The model calls the tool again** with a new `toolCallId` after a slow or failed answer.
- **Two callers** ask for the same slot at the same moment.
- **Stripe's answer is lost**, Stripe returns a 500, or Stripe is down when a hold runs out.
- **The receiver dies** after writing the booking but before answering Vapi.

The honest receptionist (`src/honest/`) keeps four guarantees:

1. **Tool-call ledger first.** A `tool_calls` row keyed by `toolCallId` is committed before the
   tool runs. A finished call that comes back answers its stored outcome and runs nothing, even
   if the booking was cancelled in between.
2. **Business keys the database enforces.** A partial unique index allows one live booking per
   slot and one per call. A re-call with a new id gets the call's existing booking back; a second
   caller gets `slot_taken` and three free alternatives.
3. **One deposit per booking.** The `deposits` row is committed before Stripe is called, and the
   `Idempotency-Key` is derived from the booking (`deposit-<ref>`), so a retry after a lost answer
   or a crash replays the same Checkout Session. A stored Stripe 500 is replayed too: the deposit
   stays `unknown` for the front desk instead of risking a second session under a new key.
4. **A hold is released only after Stripe says it is unpaid.** A deposit paid after the hold ran
   out confirms the booking; if Stripe cannot be asked, the hold stays.

Plus: requests are accepted only with a valid HMAC over `{timestamp}.{body}` inside a 5-minute
window, bodies over 1 MB are refused before buffering, and only the number on the line
(`call.customer.number`) can move, cancel or pay for a booking.

## The tools

| Tool | Arguments | Result `status` |
| --- | --- | --- |
| `check_availability` | `date` (YYYY-MM-DD) | free slots |
| `book_appointment` | `slot`, `name`, `phone`? | `booked`, `already_booked`, `slot_taken`, `outside_hours`, `in_the_past`, `invalid_slot` |
| `reschedule_appointment` | `bookingRef`, `newSlot` | `rescheduled`, `unchanged`, `slot_taken`, `not_found` |
| `cancel_appointment` | `bookingRef` | `cancelled`, `already_cancelled`, `already_released`, `not_found` |
| `send_deposit_link` | `bookingRef` | `link_sent`, `already_paid`, `pending`, `not_found` |
| `check_deposit` | `bookingRef` | `paid`, `unpaid`, `hold_expired`, `no_link`, `not_found` |
| `take_message` | `name`, `reason`, `phone`? | `message_taken` (one per call) |
| `lookup_faq` | `topic` | the answer, or `unknown_topic` |

`transfer-destination-request` returns the front desk's number during opening hours and
`{"error": "The office is closed. Offer to take a message."}` outside them. Invalid arguments come
back as an `error` string with HTTP 200, as Vapi expects. Contract details: [docs/sources.md](docs/sources.md).

## Run it

Node 22.12 or later.

```sh
npm ci
npm test            # 46 tests, node:test over real HTTP
npm run typecheck
npm run footguns    # each footgun must make exactly its documented tests fail
```

## Footguns

Each patch in [`footguns/`](footguns/) reintroduces one mistake with a one-line change.
`npm run footgun <name>` applies it, runs the suite, reverts it, and passes only if exactly the
tests named in [`footguns/manifest.json`](footguns/manifest.json) fail.

| Footgun | The mistake | Caught by |
| --- | --- | --- |
| `skip-signature-check` | any POST is processed | 9 signature tests |
| `no-tool-call-ledger` | a redelivered tool call runs again | the late redelivery after a cancel |
| `no-slot-unique-index` | the database allows two live bookings on a slot | double-booking, race, reschedule, two hold tests |
| `no-recall-lookup` | a re-call is a new booking | two re-call tests, the `after_booking` crash |
| `fresh-stripe-key` | a random idempotency key | lost answer, stored 500, the `after_stripe` crash |
| `release-without-asking-stripe` | a hold is released without checking payment | paid-after-expiry, Stripe-down |
| `no-ownership-check` | anyone with a ref can cancel | two ownership tests |

[`test/naive.test.ts`](test/naive.test.ts) runs the naive receptionist (`src/naive/`) on the same
calls: it creates two Checkout Sessions for one deposit and books a cancelled slot again.

## Limits

- **No real Vapi call yet.** Vapi's side is a fake built from its documentation; no assistant,
  phone number or recording is part of this repo.
- **No real Stripe.** The fake implements the documented idempotency rules, not Checkout itself.
  Payment is checked by `check_deposit` and when a hold expires; Stripe webhooks are not used.
- **The deposit link is returned, not texted.** Sending it by SMS is not implemented.
- **Caller ID can be spoofed.** Ownership rests on the number Vapi sees on the line; a PIN or a
  one-time code would be the next step for a clinic that needs more.
- **One process, one SQLite file.** A fixed UTC offset for the clinic, no daylight saving time.
- **Stripe keeps idempotency keys for at least 24 hours**; a deposit left `unknown` for longer
  must be reconciled by hand, as Stripe advises.
