# Live run: one recorded Vapi voice call

`live/run-live.ts` runs this receiver against real Vapi once and saves what happened to
`docs/live-call/`. Vapi's own voice simulation plays the caller (an AI tester following
`scenarioBody` in `live/config.ts`), so no phone number and no human voice are involved.

## What it needs

- `VAPI_API_KEY`: a Vapi **private** key. The run spends Vapi credits (two short voice legs:
  the tester and the assistant, capped at 4 minutes by `maxDurationSeconds`).
- `cloudflared` on the PATH (a Cloudflare quick tunnel, no account).
- No Stripe account: deposits go to the fake Stripe from the tests, and the summary says so.

The three runs of 2026-11-20, with what each one surfaced, are in
[`docs/live-call/`](../docs/live-call/).

## Run

```sh
npx tsx live/run-live.ts --dry-run     # receiver + tunnel + signed check through the tunnel, prints the Vapi requests
VAPI_API_KEY=... npx tsx live/run-live.ts
```

The run creates an HMAC credential with a fresh random secret, the assistant with the eight
tools on the tunnel URL, and a scenario, simulation and suite. It deletes the credential at the
end. Simulated callers have no caller ID, so the receiver runs with `demoCallerId` set (see
`src/honest/receptionist.ts`): every call without caller ID is owned by one demo number.
