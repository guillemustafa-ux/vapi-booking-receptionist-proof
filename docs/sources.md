# Sources

What the receiver relies on, quoted from the vendors' documentation (read 2026-11-18). Where
the docs are silent, the assumption is named.

## Vapi

**Server messages and the `tool-calls` contract** — https://docs.vapi.ai/server-url/events

> Most events are informational and do not require a response. Responses are only expected for
> these types sent to your Server URL:

followed by a list that includes `tool-calls` and `transfer-destination-request` (and
`assistant-request` and `knowledge-base-request`, which this receiver answers with `{}`).

Request: `message.type = "tool-calls"`, `message.call`, `message.toolCallList[]` with `id`,
`type: "function"`, `function.name`, `function.arguments`. Response: `{"results": [{"name",
"toolCallId", "result"}]}`.

**Result and error strings** — https://docs.vapi.ai/tools/custom-tools,
https://docs.vapi.ai/gpt-live/tools

> Use the `toolCallId` from the request. Use `result` for success and `error` for failure. Both
> must be flat strings, so serialize structured data. Return HTTP 200 even when a call fails,
> and report the failure in `error`.

**Transfer destination** — https://docs.vapi.ai/server-url/events

> Respond with a destination and optionally a message […] To refuse the transfer, respond with
> an error instead of a destination.

Documented examples: `{"destination": {"type": "number", "number": "+11234567890"}, "message":
{"type": "request-start", "message": "Transferring you now"}}` and `{"error": "The office is
closed. Offer to take a message."}`.

**Timeout and retries** — https://docs.vapi.ai/api-reference/webhooks/client-message,
https://docs.vapi.ai/whats-new/2025/8/27

> `timeoutSeconds` […] Defaults to 20 seconds.

> `backoffPlan` […] This is the backoff plan if the request fails. Defaults to undefined (the
> request will not be retried).

`backoffPlan.maxRetries` accepts 0 to 10.

*Assumption:* a `backoffPlan` retry resends the same body, so the same `toolCallId` (the docs
say a request is "retried for any non-2xx status code" and to use the `toolCallId` to recognize a
retry, but not that the body is identical). The model calling a tool again after a slow or failed
answer produces a new id. The receiver handles both (S4 and S5 in the tests).

*Assumption:* `message.call.customer.number` carries the caller ID in E.164 and is empty or
absent when the number is withheld. Ownership of a booking rests on it.

**Server authentication (HMAC)** — https://docs.vapi.ai/server-url/server-authentication,
https://docs.vapi.ai/api-reference/webhooks/server-message

> `signatureHeader` […] Defaults to 'x-signature'.
> `timestampHeader` […] Defaults to 'x-timestamp'.
> `payloadFormat` […] Defaults to '{timestamp}.{body}'.
> `signatureEncoding` […] Defaults to 'hex'.

`algorithm` is a required field of the credential, not a default: this receiver expects
`sha256`, hex, with no signature prefix (`signaturePrefix` unset). A credential configured with a
prefix such as `sha256=` would be refused.

*Assumption:* the timestamp's unit is not stated. The receiver reads a value above 10^12 as
milliseconds and anything else as seconds, and refuses a request more than 5 minutes from its
clock.

## Stripe

**Idempotent requests** — https://docs.stripe.com/api/idempotent_requests

> For API v1, Stripe saves the status code and body of the first request made with a given
> idempotency key after endpoint execution begins. Retries with the same key return the saved
> response, including `500` errors.

> If incoming parameters fail validation, or the request conflicts with another request that's
> executing concurrently, we don't save the idempotent result because no API endpoint initiates
> the execution.

> The idempotency layer compares incoming parameters to those of the original request and errors
> if they're not the same to prevent accidental misuse.

**Retrying an unresolved create** — https://docs.stripe.com/error-low-level

> Limit retries of an unresolved operation to the first 24 hours after the original request,
> using the same key and parameters. For example, if an object creation request receives no
> response because of a connection error, retrying within that window prevents the retry from
> creating a second object.

> If the outcome is still unknown after that window, don't retry with either the old key or a new
> one.

**Checkout Session lifetime and expiry** — https://docs.stripe.com/api/checkout/sessions/create,
https://docs.stripe.com/api/checkout/sessions/expire

> `expires_at` […] can be anywhere from 30 minutes to 24 hours after Checkout Session creation.
> By default, this value is 24 hours […]

A session outlives the receptionist's 15-minute hold, so the receiver calls
`POST /v1/checkout/sessions/{id}/expire` before it releases a hold or cancels a booking, and treats
a refused expire (a session that is not open any more) by reading the session. `success_url` is
listed as "required conditionally"; the receiver sends a placeholder.

The fake Stripe in `test/support/fake-stripe.ts` implements the idempotency quotes (a stored
response per key, a created session or a 500, replayed with `Idempotent-Replayed: true`, and a 400
`idempotency_error` for the same key with different parameters) and the expiry rule (an open
session can be expired; a paid or expired one cannot, and an expired one cannot be paid). It is a
model of the documentation, not of Stripe.
