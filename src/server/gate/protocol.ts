//! Client ↔ gate wire protocol — the TS mirror of the gate's Rust `protocol.rs`.
//!
//! Relay-first shape while the gate fronts `shard`: subscribe to tables (the
//! gate fans live rows back) and call reducers (the gate relays to shard).
//! Numbers ride the wire as strings (the gate stringifies them) so 64-bit
//! values survive `JSON.parse`; row payloads are coerced per-field downstream.

/** A message from the client to the gate. */
export type ClientMsg =
  | { t: "sub"; sid: number; table: string; filter?: string }
  | { t: "unsub"; sid: number }
  // `args` is the reducer's argument set as SpacetimeDB's `/call` accepts it:
  // a named object keyed by snake_case param name (preferred — the gate relays
  // it verbatim) or a positional array. u64 values must be JSON numbers.
  | { t: "call"; cid: number; reducer: string; args: unknown };

/** A raw row payload — every value is a string (see module note). */
export type RawRow = Record<string, unknown>;

/** A message from the gate to the client. */
export type GateMsg =
  | { t: "applied"; sid: number }
  | {
      t: "row";
      sid: number;
      table: string;
      op: "insert" | "update" | "delete";
      /** Present only for `"update"` — the prior row. */
      old?: RawRow;
      row: RawRow;
    }
  // `server_micros` (gate wall clock at reply time) piggybacks the client's
  // round-trip so it gets a server-time sample for free on every call — the
  // "spacetime way" (the SDK rode the timestamp on reducer events). Optional so a
  // pre-piggyback gate still parses. `GateConnection` replays it as a `time`.
  | { t: "call_ok"; cid: number; server_micros?: string }
  | { t: "call_err"; cid: number; error: string; server_micros?: string }
  | { t: "error"; error: string }
  // Server-clock heartbeat: the gate's wall clock in microseconds since epoch
  // (string — exceeds JS safe-integer range). Fed to `noteServerTime` so
  // `serverNowMs()` tracks the gate's future-stamp timeline (the players SDK
  // reducer-event anchor is gone once players move to the gate).
  | { t: "time"; server_micros: string }
  // The served DSL content changed (runtime add/modify on the gate). Carries the
  // new corpus version (hex). The client re-fetches `/content` and rebuilds.
  | { t: "content_changed"; version: string };
