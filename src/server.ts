import { createServer, type IncomingMessage, type Server } from 'node:http';
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
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://receiver.local');
    if (url.pathname !== PATH) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const raw = await readRaw(req);
    const refused = verifyRequest(raw, header(req, SIGNATURE_HEADER), header(req, TIMESTAMP_HEADER), opts.secret, now().getTime());
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
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
