/**
 * The Stripe calls the deposit needs, form-encoded as Stripe's API expects (docs/sources.md).
 * A Checkout Session create carries an `Idempotency-Key`: Stripe stores the first response for a
 * key and returns it again for a retry with the same key and parameters. A session lives 24 hours
 * by default, longer than the booking's hold, so releasing a hold expires its session first.
 */
export interface CheckoutSession {
  id: string;
  url: string;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  status: 'open' | 'complete' | 'expired';
}

/**
 * `rejected`: Stripe answered with a 4xx that means the request did not execute.
 * `unknown`: no answer, a 5xx, or a 409 (the same key still executing): it may have happened.
 */
export class StripeError extends Error {
  constructor(
    message: string,
    readonly outcome: 'rejected' | 'unknown',
  ) {
    super(message);
  }
}

export interface StripeClient {
  createDepositSession(
    p: { bookingCode: string; amountCents: number; currency: string; successUrl: string },
    idempotencyKey: string,
  ): Promise<CheckoutSession>;
  getSession(id: string, timeoutMs?: number): Promise<CheckoutSession>;
  /** Stripe refuses to expire a session that is not open (for example one already paid). */
  expireSession(id: string, timeoutMs?: number): Promise<CheckoutSession>;
}

/** Per request; a tool call makes at most one create, so it stays well inside Vapi's 20 s timeout. */
export const STRIPE_TIMEOUT_MS = 8_000;

export function createStripeClient(opts: { baseUrl: string; secretKey: string }): StripeClient {
  async function call(path: string, init: RequestInit, timeoutMs = STRIPE_TIMEOUT_MS): Promise<CheckoutSession> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${opts.baseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${opts.secretKey}`, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      throw new StripeError(`no answer from Stripe: ${err instanceof Error ? err.message : String(err)}`, 'unknown');
    }
    if (res.status >= 500 || res.status === 409) throw new StripeError(`Stripe ${res.status}: ${text}`, 'unknown');
    if (!res.ok) throw new StripeError(`Stripe ${res.status}: ${text}`, 'rejected');
    return JSON.parse(text) as CheckoutSession;
  }

  return {
    createDepositSession: (p, idempotencyKey) =>
      call('/v1/checkout/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idempotencyKey },
        body: new URLSearchParams({
          mode: 'payment',
          success_url: p.successUrl,
          'line_items[0][quantity]': '1',
          'line_items[0][price_data][currency]': p.currency,
          'line_items[0][price_data][unit_amount]': String(p.amountCents),
          'line_items[0][price_data][product_data][name]': 'Appointment deposit',
          'metadata[booking_ref]': p.bookingCode,
        }).toString(),
      }),
    getSession: (id, timeoutMs) => call(`/v1/checkout/sessions/${encodeURIComponent(id)}`, { method: 'GET' }, timeoutMs),
    expireSession: (id, timeoutMs) =>
      call(`/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, { method: 'POST' }, timeoutMs),
  };
}
