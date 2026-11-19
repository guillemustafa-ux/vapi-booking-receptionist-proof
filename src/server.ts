import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Receptionist } from './receptionist.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from './signature.js';
import { isServerMessage } from './vapi.js';

export interface ReceiverOptions {
  receptionist: Receptionist;
  /** HMAC key of the Vapi credential. Without it every POST is refused. */
  secret: string | undefined;
  now?: () => Date;
  /** Where log lines go; stderr by default. Tests pass a collector so the suite output stays clean. */
  log?: (line: string) => void;
}

export const PATH = '/vapi';

/** Larger bodies are refused with 413 before they are buffered. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The Server URL on plain `node:http`. POST /vapi only:
 *
 *   signature and timestamp checked over the raw bytes BEFORE parsing -> 401 on any failure
 *   body that is not JSON or not a server message                     -> 400
 *   tool-calls                    -> 200 { results }, one entry per tool call
 *   transfer-destination-request  -> 200 { destination, message } or { error }
 *   any other type (status-update, end-of-call-report, ...)          -> 200 {}
 *   an exception while processing -> 500
 */
export function createReceiver(opts: ReceiverOptions): Server {
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const now = opts.now ?? (() => new Date());
  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      // A request that failed before it could be answered (an aborted upload, a body too large).
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(err instanceof BodyTooLarge ? 413 : 400).end();
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://receiver.local');
    if (url.pathname !== PATH) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const signature = header(req, SIGNATURE_HEADER);
    const timestamp = header(req, TIMESTAMP_HEADER);
    // Cheap refusals first: nothing is buffered for a request that cannot be authentic.
    const early = verifyRequest(Buffer.alloc(0), signature, timestamp, opts.secret, now().getTime());
    if (early === 'no_secret' || early === 'missing_header' || early === 'stale') {
      log(`refused: ${early}`);
      res.writeHead(401).end();
      return;
    }

    const raw = await readRaw(req);
    const refused = verifyRequest(raw, signature, timestamp, opts.secret, now().getTime());
    if (refused) {
      log(`refused: ${refused}`);
      res.writeHead(401).end();
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!isServerMessage(body)) {
      res.writeHead(400).end();
      return;
    }

    try {
      const { message } = body;
      let answer: unknown = {};
      if (message.type === 'tool-calls') {
        answer = { results: await opts.receptionist.handleToolCalls(message.call!, message.toolCallList!) };
      } else if (message.type === 'transfer-destination-request') {
        answer = opts.receptionist.transferDestination(message.call!);
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    } catch (err) {
      log(`processing failed: ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(500).end();
    }
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

class BodyTooLarge extends Error {}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      reject(new BodyTooLarge('body too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        reject(new BodyTooLarge('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('aborted', () => reject(new Error('request aborted')));
    req.on('error', reject);
  });
}
