import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake of the two Stripe endpoints the deposit uses, over real HTTP, with Stripe's documented
 * idempotency behaviour (docs/sources.md): the first response for an `Idempotency-Key` is stored
 * and returned again for a retry with the same key and parameters (`Idempotent-Replayed: true`);
 * the same key with different parameters is a 400 `idempotency_error`.
 */
export interface FakeStripe {
  url: string;
  /** Checkout Sessions actually created: the number that would cost money. */
  readonly created: number;
  readonly requests: number;
  /** The next create: `drop` creates the session, then destroys the socket (the answer is lost); `500` creates nothing and is stored for its key. */
  failNext(mode: 'drop' | '500'): void;
  /** The next create answers only after this many milliseconds. */
  delayNext(ms: number): void;
  /** Stop answering (every request is dropped) until `answerAgain()`. */
  goDark(): void;
  /** Accept requests and never answer them (a hanging Stripe) until `answerAgain()`. */
  hang(): void;
  answerAgain(): void;
  /** The customer pays on the Checkout page. A session that is not open cannot be paid: returns false. */
  pay(sessionId: string): boolean;
  status(sessionId: string): Session['status'];
  sessionIds(): string[];
  close(): Promise<void>;
}

interface Session {
  id: string;
  url: string;
  payment_status: 'paid' | 'unpaid';
  status: 'open' | 'complete' | 'expired';
  amount_total: number;
  metadata: Record<string, string>;
}

export async function startFakeStripe(): Promise<FakeStripe> {
  const sessions = new Map<string, Session>();
  const byKey = new Map<string, { params: string; status: number; body: string }>();
  let created = 0;
  let requests = 0;
  let nextFailure: 'drop' | '500' | undefined;
  let nextDelayMs = 0;
  let dark = false;
  let hanging = false;

  const server = createServer(async (req, res) => {
    requests++;
    const raw = await readBody(req);
    if (hanging) return; // never answered; the client's own timeout ends it
    if (dark) {
      res.destroy();
      return;
    }
    if (req.headers.authorization !== 'Bearer sk_test_fake') {
      res.writeHead(401).end(JSON.stringify({ error: { type: 'invalid_request_error' } }));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://stripe.local');

    const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
    if (req.method === 'POST' && expire) {
      const s = sessions.get(decodeURIComponent(expire[1]!));
      if (!s) res.writeHead(404).end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing' } }));
      else if (s.status !== 'open') res.writeHead(400).end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Only open sessions can be expired.' } }));
      else {
        s.status = 'expired';
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(s));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/checkout/sessions/')) {
      const s = sessions.get(decodeURIComponent(url.pathname.slice('/v1/checkout/sessions/'.length)));
      if (!s) res.writeHead(404).end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing' } }));
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(s));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      const key = req.headers['idempotency-key'] as string | undefined;
      const prior = key ? byKey.get(key) : undefined;
      if (prior) {
        if (prior.params !== raw) {
          res.writeHead(400).end(JSON.stringify({ error: { type: 'idempotency_error' } }));
          return;
        }
        res.writeHead(prior.status, { 'content-type': 'application/json', 'idempotent-replayed': 'true' }).end(prior.body);
        return;
      }
      if (nextDelayMs) {
        const ms = nextDelayMs;
        nextDelayMs = 0;
        await new Promise((r) => setTimeout(r, ms));
      }
      const failure = nextFailure;
      nextFailure = undefined;
      if (failure === '500') {
        // Execution began and failed: Stripe v1 stores this 500 and replays it for the same key.
        const body = JSON.stringify({ error: { type: 'api_error' } });
        if (key) byKey.set(key, { params: raw, status: 500, body });
        res.writeHead(500, { 'content-type': 'application/json' }).end(body);
        return;
      }
      const form = new URLSearchParams(raw);
      const id = `cs_test_${String(++created).padStart(4, '0')}`;
      const session: Session = {
        id,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        payment_status: 'unpaid',
        status: 'open',
        amount_total: Number(form.get('line_items[0][price_data][unit_amount]')),
        metadata: { booking_ref: form.get('metadata[booking_ref]') ?? '' },
      };
      sessions.set(id, session);
      const body = JSON.stringify(session);
      if (key) byKey.set(key, { params: raw, status: 200, body });
      if (failure === 'drop') {
        res.destroy(); // created and stored, but the caller never hears back
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get created() {
      return created;
    },
    get requests() {
      return requests;
    },
    failNext: (mode) => (nextFailure = mode),
    delayNext: (ms) => (nextDelayMs = ms),
    goDark: () => (dark = true),
    hang: () => (hanging = true),
    answerAgain: () => {
      dark = false;
      hanging = false;
    },
    pay(id) {
      const s = sessions.get(id);
      if (!s) throw new Error(`no session ${id}`);
      if (s.status !== 'open') return false;
      s.payment_status = 'paid';
      s.status = 'complete';
      return true;
    },
    status(id) {
      const s = sessions.get(id);
      if (!s) throw new Error(`no session ${id}`);
      return s.status;
    },
    sessionIds: () => [...sessions.keys()],
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections(); // hanging requests too
      }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c: Buffer) => (s += c.toString()));
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}
