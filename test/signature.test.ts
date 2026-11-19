import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Receptionist } from '../src/receptionist.js';
import { createReceiver } from '../src/server.js';
import { sign, verifyRequest } from '../src/signature.js';
import { postRaw, SECRET, toolCallsBody, type PostOptions } from './support/fake-vapi.js';

const NOW = Date.parse('2026-11-20T15:00:00Z');

/** A receptionist that records what reaches it: a refused request must never get here. */
function stub() {
  const seen: string[] = [];
  const receptionist: Receptionist = {
    handleToolCalls: async (_call, toolCalls) => {
      seen.push(...toolCalls.map((t) => t.id));
      return toolCalls.map((t) => ({ name: t.function.name, toolCallId: t.id, result: '"ok"' }));
    },
    transferDestination: () => ({ error: 'closed' }),
    close: () => {},
  };
  return { receptionist, seen };
}

let server: Server | undefined;
const closeServer = () => new Promise<void>((r) => (server ? server.close(() => r()) : r()));

/** `withSecret: false` starts a receiver with no secret configured. */
async function start(withSecret = true) {
  const secret = withSecret ? SECRET : undefined;
  const s = stub();
  server = createReceiver({ receptionist: s.receptionist, secret, now: () => new Date(NOW), log: () => {} });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen: s.seen };
}

const body = toolCallsBody('call-1', [{ id: 'tc-1', name: 'lookup_faq', args: { topic: 'hours' } }]);

const refusals: Array<[string, PostOptions]> = [
  ['no signature header', { omitSignature: true }],
  ['another secret', { secret: 'not-the-secret' }],
  ['body changed after signing', { sendBody: body.replace('hours', 'parking') }],
  ['timestamp 6 minutes old', { timestamp: String(Math.floor(NOW / 1000) - 360) }],
  ['timestamp 6 minutes ahead', { timestamp: String(Math.floor(NOW / 1000) + 360) }],
  ['non-numeric timestamp', { timestamp: 'yesterday' }],
  ['non-hex signature', { headers: { 'x-signature': 'zz' } }],
];

describe('signed requests only (S3)', () => {
  afterEach(closeServer);

  it('accepts a request signed with the secret over {timestamp}.{body}', async () => {
    const { url, seen } = await start();
    const res = await postRaw(url, body, NOW);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { results: [{ name: 'lookup_faq', toolCallId: 'tc-1', result: '"ok"' }] });
    assert.deepEqual(seen, ['tc-1']);
  });

  it('accepts a millisecond timestamp', async () => {
    const { url } = await start();
    assert.equal((await postRaw(url, body, NOW, { timestamp: String(NOW) })).status, 200);
  });

  for (const [name, opts] of refusals) {
    it(`refuses ${name} with 401 and never reaches the receptionist`, async () => {
      const { url, seen } = await start();
      const res = await postRaw(url, body, NOW, opts);
      assert.equal(res.status, 401);
      assert.deepEqual(seen, []);
    });
  }

  it('refuses everything when no secret is configured', async () => {
    const { url, seen } = await start(false);
    assert.equal((await postRaw(url, body, NOW)).status, 401);
    assert.deepEqual(seen, []);
  });

  it('refuses a signed request replayed after the freshness window', () => {
    const ts = String(Math.floor(NOW / 1000));
    const sig = sign(SECRET, ts, body);
    assert.equal(verifyRequest(Buffer.from(body), sig, ts, SECRET, NOW), null);
    assert.equal(verifyRequest(Buffer.from(body), sig, ts, SECRET, NOW + 5 * 60 * 1000 + 1), 'stale');
  });
});

describe('envelope', () => {
  afterEach(closeServer);

  it('answers 400 to a signed body that is not JSON', async () => {
    const { url } = await start();
    assert.equal((await postRaw(url, 'not json', NOW)).status, 400);
  });

  it('answers 400 to tool-calls without a call id', async () => {
    const { url, seen } = await start();
    const bad = JSON.stringify({ message: { type: 'tool-calls', call: {}, toolCallList: [] } });
    assert.equal((await postRaw(url, bad, NOW)).status, 400);
    assert.deepEqual(seen, []);
  });

  it('answers 200 with an empty object to informational messages', async () => {
    const { url } = await start();
    const res = await postRaw(url, JSON.stringify({ message: { type: 'end-of-call-report', call: { id: 'call-1' } } }), NOW);
    assert.deepEqual(res, { status: 200, json: {} });
  });

  it('answers transfer-destination-request from the receptionist', async () => {
    const { url } = await start();
    const res = await postRaw(url, JSON.stringify({ message: { type: 'transfer-destination-request', call: { id: 'c' } } }), NOW);
    assert.deepEqual(res, { status: 200, json: { error: 'closed' } });
  });
});
