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
  | { t: "call_ok"; cid: number }
  | { t: "call_err"; cid: number; error: string }
  | { t: "error"; error: string };
