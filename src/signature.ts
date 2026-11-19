import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Vapi's HMAC credential (`authenticationPlan.type: "hmac"`) with its documented defaults:
 * signature in `x-signature` as hex, timestamp in `x-timestamp`, signed payload
 * `{timestamp}.{body}` (docs/sources.md). The check runs over the exact bytes received,
 * before the body is parsed.
 */
export const SIGNATURE_HEADER = 'x-signature';
export const TIMESTAMP_HEADER = 'x-timestamp';

/** How far a request's timestamp may be from the receiver's clock: a replayed request older than this is refused. */
export const MAX_SKEW_MS = 5 * 60 * 1000;

export function sign(secret: string, timestamp: string, raw: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
}

/**
 * The docs do not state the timestamp's unit; a value above 1e12 is read as milliseconds,
 * anything else as seconds. Returns NaN for a non-numeric header.
 */
export function timestampMs(timestamp: string): number {
  if (!/^\d{1,16}$/.test(timestamp)) return Number.NaN;
  const n = Number(timestamp);
  return n > 1e12 ? n : n * 1000;
}

export type VerifyFailure = 'no_secret' | 'missing_header' | 'stale' | 'bad_signature';

/**
 * Null when the request is authentic and fresh; otherwise why it is refused.
 * A receiver without a secret accepts nothing.
 */
export function verifyRequest(
  raw: Buffer,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string | undefined,
  nowMs: number,
): VerifyFailure | null {
  if (!secret) return 'no_secret';
  if (!signature || !timestamp) return 'missing_header';
  const ts = timestampMs(timestamp);
  if (Number.isNaN(ts) || Math.abs(nowMs - ts) > MAX_SKEW_MS) return 'stale';
  if (!/^[0-9a-f]+$/i.test(signature)) return 'bad_signature';
  const received = Buffer.from(signature, 'hex');
  const expected = Buffer.from(sign(secret, timestamp, raw), 'hex');
  // timingSafeEqual throws on a length mismatch; a short header is simply wrong.
  if (received.length !== expected.length) return 'bad_signature';
  return timingSafeEqual(received, expected) ? null : 'bad_signature';
}
