/**
 * One real, recorded Vapi voice call against this receiver.
 *
 *   VAPI_API_KEY=<private key> npx tsx live/run-live.ts            # the real run (spends Vapi credits)
 *   npx tsx live/run-live.ts --dry-run                             # everything local, no Vapi call
 *
 * Steps:
 *   1. start the honest receiver on a fresh SQLite file, with the fake Stripe from the tests
 *      (no real Stripe account is involved) and a fresh random HMAC secret
 *   2. expose it with a Cloudflare quick tunnel (`cloudflared`, no account) and check, through
 *      the tunnel, that an unsigned request is refused and a signed one is answered
 *   3. create in Vapi: an HMAC credential with that secret, the assistant with the eight tools
 *      pointing at the tunnel, and a voice simulation (Vapi's AI tester plays the caller)
 *   4. run it, wait for the end, download the target call's recording, transcript and messages,
 *      and dump the receiver's tool_calls / bookings / deposits rows
 *   5. delete the credential (it holds the secret), stop the tunnel and the receiver
 *
 * Output: docs/live-call/ (recording, transcript.md, call.json, ledger.json, summary.md).
 * Simulated callers carry no caller ID, so the receiver runs with DEMO_CALLER_ID set.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createHonestReceptionist } from '../src/honest/receptionist.js';
import { createReceiver, PATH } from '../src/server.js';
import { sign } from '../src/signature.js';
import { createStripeClient } from '../src/stripe.js';
import { startFakeStripe } from '../test/support/fake-stripe.js';
import { assistantBody, scenarioBody, nextWorkday } from './config.js';

const DRY = process.argv.includes('--dry-run');
const VAPI = 'https://api.vapi.ai';
const KEY = (process.env.VAPI_API_KEY ?? '').replace(/"/g, '').trim();
const DEMO_CALLER = '+15555550142';
const OUT = fileURLToPath(new URL('../docs/live-call/', import.meta.url));
const log = (s: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${s}\n`);

if (!DRY && !KEY) {
  console.error('VAPI_API_KEY is not set. Use --dry-run to check everything local first.');
  process.exit(1);
}

async function vapi<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  if (DRY) {
    log(`[dry-run] ${method} ${path}${body ? `\n${JSON.stringify(body, null, 2)}` : ''}`);
    return { id: `dry-${path.split('/').filter(Boolean).join('-')}` } as T;
  }
  const res = await fetch(`${VAPI}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 2000)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function startTunnel(port: number): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`no tunnel URL after 60 s:\n${seen.slice(-2000)}`)), 60_000);
    const onData = (d: Buffer) => {
      seen += d.toString();
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(seen);
      if (m) {
        clearTimeout(timer);
        resolve({ url: m[0], proc });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
  });
}

/** The tunnel must refuse an unsigned request and answer a signed FAQ lookup. */
async function checkThroughTunnel(url: string, secret: string): Promise<void> {
  const body = JSON.stringify({
    message: { type: 'tool-calls', call: { id: 'tunnel-check' }, toolCallList: [{ id: `check-${randomUUID()}`, type: 'function', function: { name: 'lookup_faq', arguments: { topic: 'hours' } } }] },
  });
  // A lookup before the quick-tunnel hostname exists gets cached as NXDOMAIN by Windows for about a minute.
  await new Promise((r) => setTimeout(r, 15_000));
  for (let attempt = 1; ; attempt++) {
    try {
      const unsigned = await fetch(`${url}${PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (unsigned.status !== 401) throw new Error(`unsigned request through the tunnel got ${unsigned.status}, expected 401`);
      const ts = String(Math.floor(Date.now() / 1000));
      const signed = await fetch(`${url}${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature': sign(secret, ts, body) },
        body,
      });
      const text = await signed.text();
      if (signed.status !== 200 || !text.includes('Monday to Friday')) throw new Error(`signed request got ${signed.status}: ${text}`);
      log('tunnel check: unsigned 401, signed 200 with the FAQ answer');
      return;
    } catch (err) {
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
      log(`tunnel check attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}${cause}`);
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 5000)); // a fresh quick tunnel takes a while to resolve and route
    }
  }
}

// Shapes per docs.vapi.ai as of 2026-11-19: the run item carries `callId` (older payloads used
// `calls.targetCallId`) and `metadata.call` with the recording and transcript.
interface RunItem {
  status?: string;
  callId?: string;
  calls?: { targetCallId?: string; testerCallId?: string };
  metadata?: { call?: { recordingUrl?: string; transcript?: string } };
  [k: string]: unknown;
}

/** Drops what must not be committed: presigned (signed, time-limited) URLs, log URLs and the org id. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k, v]) => !/presigned|logUrl|orgId/i.test(k) && !(typeof v === 'string' && v.includes('X-Amz-')))
        .map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}

/** List endpoints answer either a bare array or `{ results: [...] }`. */
const listOf = <T>(raw: T[] | { results?: T[] }): T[] => (Array.isArray(raw) ? raw : (raw.results ?? []));

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'vapi-live-'));
  const dbPath = join(work, 'receptionist.db');
  const secret = randomBytes(32).toString('hex');
  const stripe = await startFakeStripe();
  const receptionist = createHonestReceptionist({
    dbPath,
    stripe: createStripeClient({ baseUrl: stripe.url, secretKey: 'sk_test_fake' }),
    demoCallerId: DEMO_CALLER,
  });
  const server = createReceiver({ receptionist, secret, log: (l) => log(`receiver: ${l}`) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  log(`receiver on 127.0.0.1:${port}, db ${dbPath}`);

  let tunnel: { url: string; proc: ChildProcess } | undefined;
  let credentialId: string | undefined;
  try {
    tunnel = await startTunnel(port);
    log(`tunnel ${tunnel.url}`);
    await checkThroughTunnel(tunnel.url, secret);

    const day = nextWorkday(new Date());
    const credential = await vapi<{ id: string }>('POST', '/credential', {
      provider: 'custom-credential',
      name: 'vapi-booking-receptionist-proof live run',
      authenticationPlan: { type: 'hmac', algorithm: 'sha256', secretKey: secret, signatureHeader: 'x-signature', timestampHeader: 'x-timestamp', payloadFormat: '{timestamp}.{body}', signatureEncoding: 'hex' },
    });
    credentialId = credential.id;
    const assistant = await vapi<{ id: string }>('POST', '/assistant', assistantBody(`${tunnel.url}${PATH}`, credential.id, day));
    log(`assistant ${assistant.id}`);

    type Personality = { id: string; name?: string };
    const personalities = DRY ? [{ id: 'dry-personality', name: 'dry' }] : listOf(await vapi<Personality[] | { results?: Personality[] }>('GET', '/eval/simulation/personality'));
    const personality = personalities.find((p) => /default|normal|neutral|polite|friendly/i.test(p.name ?? '')) ?? personalities[0];
    if (!personality) throw new Error('no simulation personality available');
    const scenario = await vapi<{ id: string }>('POST', '/eval/simulation/scenario', scenarioBody(day));
    const simulation = await vapi<{ id: string }>('POST', '/eval/simulation', { scenarioId: scenario.id, personalityId: personality.id, name: 'Book, deposit, insurance' });
    const suite = await vapi<{ id: string }>('POST', '/eval/simulation/suite', { name: 'vapi-booking-receptionist-proof', simulationIds: [simulation.id] });
    const created = await vapi<{ id?: string; runId?: string }>(
      'POST',
      '/eval/simulation/run',
      { simulations: [{ type: 'simulationSuite', simulationSuiteId: suite.id }], target: { type: 'assistant', assistantId: assistant.id }, transport: { provider: 'vapi.websocket' }, iterations: 1 },
      { 'idempotency-key': `proof-live-${randomUUID()}` },
    );
    // The API reference returns the run object (`id`); the simulations guide shows `{ runId }`.
    const runId = created.id ?? created.runId;
    if (!runId) throw new Error(`no run id in the create-run answer: ${JSON.stringify(created).slice(0, 500)}`);
    const run = { id: runId };
    log(`simulation run ${run.id} (voice)`);

    if (DRY) {
      log('[dry-run] stopping before any Vapi call is made');
      return;
    }

    const deadline = Date.now() + 8 * 60_000;
    let status = '';
    while (Date.now() < deadline) {
      status = (await vapi<{ status: string }>('GET', `/eval/simulation/run/${run.id}`)).status;
      if (status === 'ended') break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (status !== 'ended') throw new Error(`simulation run still ${status} after 8 minutes`);
    const items = listOf(await vapi<RunItem[] | { results?: RunItem[] }>('GET', `/eval/simulation/run/${run.id}/item`));
    writeFileSync(join(OUT, 'run-items.json'), JSON.stringify(redact(items), null, 2));
    const item = items[0];
    const targetCallId = item?.callId ?? item?.calls?.targetCallId;
    if (!targetCallId) throw new Error('no callId in the run items; see docs/live-call/run-items.json');

    // recordingUrl points at a private bucket (it answers an `InvalidArgument: Authorization` XML error); presignedMonoUrl is the downloadable one, valid ~30 min.
    const call = await vapi<{ artifact?: { presignedMonoUrl?: string; recordingUrl?: string; recording?: { mono?: { combinedUrl?: string } }; transcript?: string; messages?: unknown[] } }>(
      'GET',
      `/call/${targetCallId}`,
    );
    writeFileSync(join(OUT, 'call.json'), JSON.stringify(redact(call), null, 2));
    const recordingUrl = call.artifact?.presignedMonoUrl ?? call.artifact?.recordingUrl ?? call.artifact?.recording?.mono?.combinedUrl ?? item?.metadata?.call?.recordingUrl;
    const audio = recordingUrl ? await fetch(recordingUrl) : undefined;
    if (audio?.ok) {
      const ext = (audio.headers.get('content-type') ?? '').includes('wav') ? 'wav' : 'mp3';
      writeFileSync(join(OUT, `recording.${ext}`), Buffer.from(await audio.arrayBuffer()));
      log(`recording saved: docs/live-call/recording.${ext}`);
    } else log(`recording not saved: ${audio ? `HTTP ${audio.status}` : 'no recording URL on the call artifact'}`);
    writeFileSync(join(OUT, 'transcript.md'), `# Transcript (call ${targetCallId})\n\n${call.artifact?.transcript ?? item?.metadata?.call?.transcript ?? '(none)'}\n`);

    const db = new Database(dbPath, { readonly: true });
    const ledger = {
      tool_calls: db.prepare('select tool_call_id, name, args_json, status, outcome_json, deliveries from tool_calls order by first_seen_at').all(),
      bookings: db.prepare('select ref, slot, name, status, phone, callback_phone from bookings').all(),
      deposits: db.prepare('select booking_ref, status, session_id from deposits').all(),
    };
    db.close();
    writeFileSync(join(OUT, 'ledger.json'), JSON.stringify(ledger, null, 2));
    writeFileSync(
      join(OUT, 'summary.md'),
      `# Live call summary\n\n- Vapi call: \`${targetCallId}\`\n- Simulation run: \`${run.id}\` (voice, Vapi's AI tester as the caller)\n- Tool calls received by the receiver through the tunnel, HMAC-verified: ${ledger.tool_calls.length} (the first is the harness's own tunnel check)\n- Bookings: ${JSON.stringify(ledger.bookings)}\n- Deposits (fake Stripe): ${JSON.stringify(ledger.deposits)}\n`,
    );
    log(`done: ${ledger.tool_calls.length} tool calls, ${ledger.bookings.length} booking(s)`);
  } finally {
    if (credentialId && !DRY) await vapi('DELETE', `/credential/${credentialId}`).catch((e) => log(`could not delete the credential: ${e}`));
    tunnel?.proc.kill();
    await new Promise<void>((r) => server.close(() => r()));
    receptionist.close();
    await stripe.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
