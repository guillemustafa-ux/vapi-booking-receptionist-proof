/**
 * The two Stripe calls the deposit needs, form-encoded as Stripe's API expects
 * (docs/sources.md). A Checkout Session create carries an `Idempotency-Key`: Stripe stores the
 * first response for a key and returns it again for a retry with the same key and parameters.
 */
export interface CheckoutSession {
  id: string;
  url: string;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  status: 'open' | 'complete' | 'expired';
}

/** `rejected`: Stripe answered with an error, nothing was created. `unknown`: no answer, it may have been. */
export class StripeError extends Error {
  constructor(
    message: string,
    readonly outcome: 'rejected' | 'unknown',
  ) {
    super(message);
  }
}

export interface StripeClient {
  createDepositSession(p: { bookingRef: string; amountCents: number; currency: string }, idempotencyKey: string): Promise<CheckoutSession>;
  getSession(id: string): Promise<CheckoutSession>;
}

export function createStripeClient(opts: { baseUrl: string; secretKey: string }): StripeClient {
  async function call(path: string, init: RequestInit): Promise<CheckoutSession> {
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${opts.secretKey}`, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(8_000), // well inside Vapi's 20 s tool timeout
      });
    } catch (err) {
      throw new StripeError(`no answer from Stripe: ${err instanceof Error ? err.message : String(err)}`, 'unknown');
    }
    const text = await res.text().catch(() => '');
    if (res.status >= 500) throw new StripeError(`Stripe ${res.status}: ${text}`, 'unknown');
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
          'line_items[0][quantity]': '1',
          'line_items[0][price_data][currency]': p.currency,
          'line_items[0][price_data][unit_amount]': String(p.amountCents),
          'line_items[0][price_data][product_data][name]': 'Appointment deposit',
          'metadata[booking_ref]': p.bookingRef,
        }).toString(),
      }),
    getSession: (id) => call(`/v1/checkout/sessions/${encodeURIComponent(id)}`, { method: 'GET' }),
  };
}
