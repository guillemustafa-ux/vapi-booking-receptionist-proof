-- The honest receptionist's ledger. One SQLite file, one receiver process per file.

-- One row per Vapi tool call id, written synchronously before the tool runs. A redelivery with
-- the same id finds the row: a finished call answers its stored result and runs nothing.
create table if not exists tool_calls (
  tool_call_id  text primary key,
  vapi_call_id  text not null,
  name          text not null,
  args_json     text not null,
  status        text not null,          -- started | done
  outcome_json  text,                   -- {"result": "..."} or {"error": "..."}
  deliveries    integer not null default 1,
  first_seen_at text not null,
  finished_at   text
);

create table if not exists bookings (
  ref             text primary key,     -- short code a caller can read back, e.g. BK-7Q2M9X
  vapi_call_id    text not null,
  phone           text not null,        -- owner: caller ID on the line that booked
  callback_phone  text not null,        -- the number the caller asked to be called back on
  name            text not null,
  slot            text not null,        -- clinic-local YYYY-MM-DDTHH:MM
  status          text not null,        -- held | confirmed | cancelled | expired
  hold_expires_at text,                 -- set while the deposit is unpaid
  created_at      text not null,
  updated_at      text not null
);

-- The database, not a read-then-write check, refuses a second live booking on a slot.
create unique index if not exists one_live_booking_per_slot
  on bookings (slot) where status in ('held', 'confirmed');

-- One live booking per call: the model re-sending book_appointment gets the first booking back.
create unique index if not exists one_live_booking_per_call
  on bookings (vapi_call_id) where status in ('held', 'confirmed');

-- One deposit per booking. The row is committed before Stripe is called; its idempotency key
-- is derived from the booking, so a retry after a crash or a lost answer replays, not charges.
create table if not exists deposits (
  booking_ref     text primary key references bookings (ref),
  idempotency_key text not null unique,
  status          text not null,        -- creating | open | paid | expired | failed | unknown
  session_id      text unique,
  url             text,
  error           text,
  created_at      text not null,
  updated_at      text not null
);

-- After-hours messages: one per call.
create table if not exists messages (
  vapi_call_id text primary key,
  name         text not null,
  phone        text not null,
  reason       text not null,
  created_at   text not null
);
