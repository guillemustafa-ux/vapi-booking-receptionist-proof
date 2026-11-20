# vapi-booking-receptionist-proof

The Server URL of a dental-clinic voice receptionist on Vapi, in Node + TypeScript with SQLite.
It shows that **a phone call cannot book a slot twice, double-book it, or leave two payable
deposit links for one slot**, even when a tool call is redelivered, the model calls the same tool
again after a slow answer, two callers race for one slot, Stripe loses an answer or hangs, or the
receiver is killed mid-request.

Tested offline: a fake Vapi that signs requests the way Vapi's HMAC credential does, a fake Stripe
with Stripe's documented idempotency and session-expiry behaviour, and a receiver process killed
with `SIGKILL`; no Vapi account and no real Stripe. Then [three recorded Vapi voice calls](docs/live-call/)
ran this receiver for real through a tunnel, with Vapi's AI tester as the caller and the fake Stripe
(see [Limits](#limits)).

| The ask | Where it is covered |
| --- | --- |
| «10 scripted test calls (booking, reschedule, cancel, double-booking attempt, paid deposit, unpaid deposit, transfer, after-hours message, two FAQs)» | [`test/scripted-calls.test.ts`](test/scripted-calls.test.ts): one test per call, in that order |
| "AI Receptionist with Booking & Stripe Deposits" | booking with a 15-minute hold, a Stripe Checkout deposit link, paid confirms, unpaid releases after the link is expired |
| no duplicate bookings or charges when a call goes wrong | [`test/duplicates.test.ts`](test/duplicates.test.ts), [`test/crash.test.ts`](test/crash.test.ts), [`test/refutation.test.ts`](test/refutation.test.ts) |

## What it proves

A tool call on a live phone call can run more than once without anyone asking twice:

- **The same tool call arrives again** with the same `toolCallId`: Vapi retries a failed request
  when a `backoffPlan` is set (assumed to resend the same body, see
  [docs/sources.md](docs/sources.md)), or a captured signed request is replayed inside the
  freshness window.
- **The model calls the tool again** with a new `toolCallId` after a slow or failed answer
  (Vapi's tool timeout defaults to 20 seconds).
- **Two callers** ask for the same slot at the same moment.
- **Stripe's answer is lost**, Stripe returns a 500, or Stripe is down or hanging.
- **The receiver dies** after writing the booking but before answering Vapi.

The honest receptionist (`src/honest/`) keeps these guarantees:

1. **Tool-call ledger first.** A `tool_calls` row keyed by `toolCallId` is committed before the
   tool runs. A finished call that comes back answers its stored outcome and runs nothing, even
   if the booking was cancelled in between.
2. **Business keys the database enforces.** A partial unique index allows one live booking per
   slot and one per call. A re-call with a new id gets the call's existing booking back; a second
   caller gets `slot_taken` and three free alternatives.
3. **One deposit per booking.** The `deposits` row is committed before Stripe is called, and the
   `Idempotency-Key` is derived from the booking (`deposit-<ref>`), so a retry after a lost answer
   or a crash replays the same Checkout Session. A stored Stripe 500 is replayed too: the deposit
   stays `unknown` in the `deposits` table, and its hold stays, rather than risking a second
   session under a new key.
4. **A released or cancelled booking's link cannot be paid.** A Checkout Session lives 24 hours
   by default, longer than the hold, so a hold is released and a booking cancelled only after
   Stripe has expired its open session. If the session was already paid, the booking is confirmed
   instead (or, on a cancel, flagged for a refund). If Stripe cannot be asked, nothing is
   released or cancelled.
5. **A hanging Stripe cannot stall a call.** Expired holds are checked at the start of a request
   within a 6-second budget (2.5 s per Stripe request); what is left is checked on a later request.

Plus: requests are accepted only with a valid HMAC over `{timestamp}.{body}` inside a 5-minute
window. A body declared over 1 MB is refused before it is read, and a chunked body is cut off at
1 MB. A booking belongs to the caller ID on the line that made it (`call.customer.number`): only
that number can move, cancel or pay for it. A number the caller says is stored as a callback
number, never as proof of ownership, and a call with the number withheld can leave a message but
not book.

## The tools

| Tool | Arguments | Result `status` |
| --- | --- | --- |
| `check_availability` | `date` (YYYY-MM-DD) | free slots |
| `book_appointment` | `slot`, `name`, `phone`? (callback) | `booked`, `already_booked`, `slot_taken`, `no_caller_id`, `outside_hours`, `in_the_past`, `invalid_slot` |
| `reschedule_appointment` | `bookingCode`, `newSlot` | `rescheduled`, `unchanged`, `slot_taken`, `not_found`, `outside_hours`, `in_the_past`, `invalid_slot` |
| `cancel_appointment` | `bookingCode` | `cancelled`, `already_cancelled`, `already_released`, `not_found`; an `error` if Stripe cannot be asked |
| `send_deposit_link` | `bookingCode` | `link_sent`, `already_paid`, `pending`, `not_found` |
| `check_deposit` | `bookingCode` | `paid`, `unpaid`, `hold_expired`, `cancelled`, `no_link`, `not_found` |
| `take_message` | `name`, `reason`, `phone`? | `message_taken` (one per call; a second one is not stored) |
| `lookup_faq` | `topic` | the answer, or `unknown_topic` |

`transfer-destination-request` returns the front desk's number during opening hours and
`{"error": "The office is closed. Offer to take a message."}` outside them. Invalid arguments come
back as an `error` string with HTTP 200, as Vapi expects. Contract details: [docs/sources.md](docs/sources.md).

## Run it

Node 22.14 or later (the `better-sqlite3` 13 prebuilt binary needs N-API 10; on Node 22.12 and
22.13 it crashes).

```sh
npm ci
npm test            # 55 tests with node:test; all but one go through HTTP
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
| `release-without-asking-stripe` | a hold is released without expiring its link | paid-after-expiry, Stripe down, P1, the hanging-Stripe test |
| `cancel-without-expiring` | a cancel leaves the link payable | two cancel tests |
| `no-sweep-budget` | the hold sweep waits on a hanging Stripe | the hanging-Stripe test |
| `owner-is-spoken-number` | the said number owns the booking | P2a, P2b, P13 |
| `no-ownership-check` | anyone with a ref can cancel | three ownership tests |

[`test/naive.test.ts`](test/naive.test.ts) runs the naive receptionist (`src/naive/`) on the same
calls: it creates two Checkout Sessions for one deposit and books a cancelled slot again.

## Limits

- **The live calls are simulations, not phone calls.** The tests use a fake Vapi built from its
  documentation. The [three live runs](docs/live-call/) are real Vapi voice calls, but the caller
  is Vapi's AI tester over its websocket transport: no phone number and no human. Those calls carry
  no caller ID, so the runs set `demoCallerId`. `assistant-request` and `knowledge-base-request`
  are answered with `{}`.
- **No real Stripe.** The fake implements the documented idempotency and expiry rules, not
  Checkout itself; the success URL is a placeholder. Payment is checked by `check_deposit`, on
  release and on cancel; Stripe webhooks are not used. There is no refund flow.
- **The deposit link is returned, not texted.** Sending it by SMS is not implemented.
- **A deposit left `unknown`** (a lost answer that was never retried, or a stored Stripe 500)
  keeps its hold until someone reconciles it by hand; it is only visible in the `deposits` table.
  After 23 hours the receiver stops retrying it, because Stripe may have pruned the key.
- **Caller ID can be spoofed.** Ownership rests on the number Vapi sees on the line; a PIN or a
  one-time code would be the next step for a clinic that needs more.
- **One live booking and one message per call**: a second family member on the same call is told
  `already_booked`.
- **`toolCallId` is assumed globally unique**; the ledger is keyed by it alone.
- **One process, one SQLite file, one chair**, a fixed UTC offset with no daylight saving time, no
  calendar or practice-system integration. Names, numbers and reasons are stored in plain text with
  no retention policy. The receiver listens on `127.0.0.1`.
