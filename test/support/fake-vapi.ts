import { sign } from '../../src/signature.js';
import { PATH } from '../../src/server.js';

export const SECRET = 'test-vapi-hmac-secret';
export const CALLER = '+15555550123';

export interface Posted {
  status: number;
  json: unknown;
}

export interface PostOptions {
  secret?: string;
  /** Unix seconds as a string; defaults to the given clock. */
  timestamp?: string;
  /** Sent instead of the signed body (a body changed after signing). */
  sendBody?: string;
  headers?: Record<string, string>;
  omitSignature?: boolean;
}

/** Posts a raw body the way Vapi does: HMAC-SHA256 of `{timestamp}.{body}` in `x-signature`. */
export async function postRaw(baseUrl: string, body: string, nowMs: number, opts: PostOptions = {}): Promise<Posted> {
  const timestamp = opts.timestamp ?? String(Math.floor(nowMs / 1000));
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-timestamp': timestamp };
  if (!opts.omitSignature) headers['x-signature'] = sign(opts.secret ?? SECRET, timestamp, body);
  Object.assign(headers, opts.headers); // last, so a case can replace the signature itself
  const res = await fetch(`${baseUrl}${PATH}`, { method: 'POST', headers, body: opts.sendBody ?? body });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : undefined };
}

export interface ScriptedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export function toolCallsBody(callId: string, calls: ScriptedToolCall[], caller = CALLER): string {
  return JSON.stringify({
    message: {
      type: 'tool-calls',
      call: { id: callId, customer: { number: caller } },
      toolCallList: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
    },
  });
}

export function transferBody(callId: string, caller = CALLER): string {
  return JSON.stringify({ message: { type: 'transfer-destination-request', call: { id: callId, customer: { number: caller } } } });
}
