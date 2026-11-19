# Sources

What the receiver relies on, quoted from the vendors' documentation (read 2026-11-18). Where
the docs are silent, the assumption is named.

## Vapi

**Server messages and the `tool-calls` contract** — https://docs.vapi.ai/server-url/events

> Most events are informational and do not require a response, but certain types like
> 'assistant-request', 'tool-calls', 'transfer-destination-request', and 'knowledge-base-request'
> expect a response.

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

*Assumption:* a `backoffPlan` retry resends the same body, so the same `toolCallId`. The model
calling a tool again after a slow or failed answer produces a new id. The receiver handles both
(S4 and S5 in the tests).

**Server authentication (HMAC)** — https://docs.vapi.ai/server-url/server-authentication,
https://docs.vapi.ai/api-reference/webhooks/server-message

> `signatureHeader` […] Defaults to 'x-signature'.
> `timestampHeader` […] Defaults to 'x-timestamp'.
> `payloadFormat` […] Defaults to '{timestamp}.{body}'.
> `signatureEncoding` […] Defaults to 'hex'.

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
> response because of a connection error, retrying within that window prevents creating a second
> object.

> If the outcome is still unknown after that window, don't retry with either the old key or a new
> one.

The fake Stripe in `test/support/fake-stripe.ts` implements the first three quotes: a stored
response per key (a created session or a 500), replayed with `Idempotent-Replayed: true`, and a
400 `idempotency_error` for the same key with different parameters.
