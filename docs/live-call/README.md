# Live calls: three recorded Vapi voice simulations (2026-11-20)

[`live/run-live.ts`](../../live/run-live.ts) ran this receiver against real Vapi three times. Each run:

1. started the honest receiver on a fresh SQLite file, with the fake Stripe from the tests;
2. exposed it through a Cloudflare quick tunnel and checked, through the tunnel, that an unsigned
   request is refused (401) and a signed one is answered (200);
3. created in Vapi an HMAC credential with a fresh random secret (deleted at the end of the run),
   the assistant from [`live/config.ts`](../../live/config.ts) (OpenAI `gpt-4.1-mini`, Vapi voice,
   Deepgram `nova-3`) with the eight tools on the tunnel URL, and one voice simulation in which
   Vapi's AI tester plays the caller;
4. saved the recording, the transcript, Vapi's call and run-item answers, and the receiver's
   `tool_calls`, `bookings` and `deposits` rows.

The caller's script (`scenarioBody`): book a teeth cleaning on Monday 23 November 2026 at 10 am,
give the name, ask for the deposit link, ask whether Delta Dental is accepted, then hang up.

## The three runs

| Run | Recording | Vapi evaluation | What happened | Changed before the next run |
| --- | --- | --- | --- | --- |
| 1 | [run-1/recording.mp3](run-1/recording.mp3), 75 s | passed | Booked `BK-C52WUH` on 23 Nov at 10:00 and sent the deposit link. On the caller's "Thank you" the assistant said goodbye and ended the call while the caller was still speaking ("Could you please re…"); the insurance question was never asked. | Prompt: end the call only after a goodbye or "nothing else"; a thank-you alone is not a goodbye. |
| 2 | [run-2/recording.mp3](run-2/recording.mp3), 66 s | passed | The insurance question was answered from `lookup_faq`. But "twenty-third" was transcribed as "20 third" and the assistant booked `BK-AGQTFW` on **20** Nov at 10:00. | Prompt: read back weekday, date and time in words and wait for a yes before booking; "20 third" means the 23rd. The prompt's example read-back, "Monday, November 23rd at 10 am", is this scenario's own slot. |
| 3 | [run-3/recording.mp3](run-3/recording.mp3), 91 s | passed | The assistant read back the slot ("Monday, November 20 third, at 10 AM" in the transcript), the caller said yes, and it booked `BK-ETDWQE` on 23 Nov at 10:00. `lookup_faq` returned the insurance answer, but the caller spoke over the assistant after "We do" and the assistant never finished it; the tester took that as a yes. Deposit link sent; the call ended after the caller said that was all. | Open: after being interrupted, the assistant did not finish the insurance answer. |

The evaluation (the structured output in `scenarioBody`, scored by Vapi) only checks that a `BK-`
booking code was given and a deposit link was sent, so it passed run 2 with the wrong date. The
dates above come from each run's `ledger.json`.

## What the receiver saw

- **Every tool call came through the tunnel signed.** The receiver refuses unsigned requests before
  doing anything, so each row in `ledger.json` passed the HMAC check: 5, 7 and 7 rows. The first
  row of each run is the harness's own signed tunnel check; the assistant made 4, 6 and 6 calls.
- **Each run's model sent a wrong argument name, and validation caught it.** In all three runs
  the model first called `send_deposit_link` with `bookingCode` instead of `bookingRef`. The
  receiver answered `invalid arguments: bookingRef is required` and the model retried with
  `bookingRef`. In run 3 it got the error, asked the caller to confirm the code, sent `bookingCode`
  again, got the error again, and then used `bookingRef`. The schema already declares only
  `bookingRef`; a different argument name might avoid the drift, but it was not changed here.
- **A repeated deposit request made no second payment link.** In run 2 the model called
  `send_deposit_link` twice for the same booking; there is one Checkout Session (`cs_test_0001`).
- One booking per run, left `held`: the fake Stripe link is never paid.

## Limits of these runs

- **Simulated caller, not a phone line.** The caller is Vapi's AI tester over Vapi's websocket
  transport: no phone number, no carrier, no human. Simulated calls carry no caller ID, so the
  receiver ran with `demoCallerId` set to `+15555550142`.
- **Fake Stripe.** The deposit links are not payable.
- **Transcripts are speech-to-text of both voices.** Spellings such as "Anna", "20 third" or
  "b k e t d w q e" are how the speech was transcribed, not what either model wrote.
- **Three runs, one scenario.** They show the receiver working on real Vapi calls; they do not
  measure how often the assistant gets a date or a hang-up wrong.
- `call.json` and `run-items.json` are Vapi's API answers with presigned URLs, log URLs and the org
  id removed. Each run's files were moved into `run-N/` and the WAV recording converted to MP3.
- Vapi's reported cost of the assistant call was USD 0.11, 0.13 and 0.19. The assistant, scenario,
  simulation and suite objects remain in the Vapi account. The harness deletes the credential at
  the end of each run and logged no error doing so.
