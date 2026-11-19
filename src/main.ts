import { CRASH_POINTS, type CrashPoint } from './crash.js';
import { createHonestReceptionist } from './honest/receptionist.js';
import { createNaiveReceptionist } from './naive/receptionist.js';
import { createReceiver } from './server.js';
import { createStripeClient } from './stripe.js';

/**
 * The receiver as a process. Environment:
 *
 *   VAPI_SECRET         HMAC key of the Vapi credential (required: without it every request is refused)
 *   STRIPE_SECRET_KEY   Stripe secret key; STRIPE_BASE_URL defaults to https://api.stripe.com
 *   DB_PATH             SQLite file (default receptionist.db); PORT (default 3000)
 *   SIDE                honest (default) | naive
 *   FAULT               crash point for the crash tests: after_booking | after_stripe
 *   CLOCK_NOW           tests only: a fixed ISO instant used as "now"
 *   DEMO_CALLER_ID      demo only: owner number for calls without caller ID (web calls, simulations)
 */
const env = (k: string) => (process.env[k] ?? '').replace(/"/g, '') || undefined;

const fault = env('FAULT') as CrashPoint | undefined;
if (fault && !CRASH_POINTS.includes(fault)) throw new Error(`unknown FAULT ${fault}`);
const fixed = env('CLOCK_NOW');
const now = fixed ? () => new Date(fixed) : () => new Date();

const stripe = createStripeClient({ baseUrl: env('STRIPE_BASE_URL') ?? 'https://api.stripe.com', secretKey: env('STRIPE_SECRET_KEY') ?? '' });
const options = { dbPath: env('DB_PATH') ?? 'receptionist.db', stripe, now, fault, demoCallerId: env('DEMO_CALLER_ID') };
if (options.demoCallerId) process.stderr.write(`DEMO_CALLER_ID is set: calls without caller ID are owned by ${options.demoCallerId}. Demo only.\n`);
const receptionist = env('SIDE') === 'naive' ? createNaiveReceptionist(options) : createHonestReceptionist(options);

const server = createReceiver({ receptionist, secret: env('VAPI_SECRET'), now });
server.listen(Number(env('PORT') ?? 3000), '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.stdout.write(`listening on http://127.0.0.1:${port}\n`);
});
