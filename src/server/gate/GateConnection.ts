//! WebSocket transport to the gate.
//!
//! Owns the socket, allocates the monotonic `sid`/`cid` ids, tracks in-flight
//! reducer calls (resolving on `call_ok`/`call_err`), and forwards every other
//! server message to a `dispatch` callback the owner sets. Messages sent before
//! the socket opens are queued.

import { debug } from "../../debug";
import type { ClientMsg, GateMsg } from "./protocol";

type Pending = { resolve: () => void; reject: (err: Error) => void; reducer: string };

export class GateConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private dispatch: (msg: GateMsg) => void = () => {};
  private outbox: string[] = [];
  /** The socket is opened lazily on the first subscribe/call (post-login), not
   *  at construction — so we don't hold a gate connection on the login screen. */
  private connectStarted = false;

  constructor(private readonly url: string) {}

  /** Register the handler for non-call server messages (`row`/`applied`/`error`). */
  setDispatch(fn: (msg: GateMsg) => void): void {
    this.dispatch = fn;
  }

  /** Open the socket on demand, exactly once. Both reads (subscribe) and
   *  writes (call) call this first; queued sends flush on open. */
  ensureConnected(): void {
    if (this.connectStarted) return;
    this.connectStarted = true;
    void this.connect(this.url).catch((err) => {
      this.connectStarted = false; // allow a later use to retry
      debug.warn(
        ["gate"],
        `connect failed: ${err instanceof Error ? err.message : String(err)}`,
        4,
      );
    });
  }

  /** Open the connection; resolves once the socket is open. */
  connect(url: string): Promise<void> {
    debug.log(["gate"], `connecting to ${url}`, 4);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        debug.log(["gate"], `connected (flushing ${this.outbox.length} queued)`, 4);
        for (const msg of this.outbox) ws.send(msg);
        this.outbox = [];
        resolve();
      };
      ws.onerror = () => {
        debug.warn(["gate"], `socket error (url=${url})`, 4);
        reject(new Error("gate connection error"));
      };
      ws.onclose = (e: CloseEvent) => {
        debug.warn(["gate"], `socket closed (code=${e.code})`, 4);
        for (const p of this.pending.values()) p.reject(new Error("gate connection closed"));
        this.pending.clear();
      };
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data === "string") this.onMessage(event.data);
      };
    });
  }

  /** Close the socket and drop its handlers — for clean teardown / HMR so the
   *  gate doesn't accumulate orphaned connections. */
  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onerror = ws.onclose = ws.onmessage = null;
    debug.log(["gate"], "closing connection", 4);
    ws.close();
  }

  /** Allocate a fresh subscription/call id. */
  allocId(): number {
    return this.nextId++;
  }

  subscribe(sid: number, table: string, filter?: string): void {
    this.send(filter === undefined ? { t: "sub", sid, table } : { t: "sub", sid, table, filter });
  }

  unsubscribe(sid: number): void {
    this.send({ t: "unsub", sid });
  }

  /** Relay a reducer call (args = `/call` named object or positional array);
   *  resolves on `call_ok`, rejects on `call_err`. */
  call(reducer: string, args: unknown): Promise<void> {
    const cid = this.allocId();
    return new Promise<void>((resolve, reject) => {
      this.pending.set(cid, { resolve, reject, reducer });
      this.send({ t: "call", cid, reducer, args });
    });
  }

  private send(msg: ClientMsg): void {
    const text = JSON.stringify(msg);
    const open = this.ws && this.ws.readyState === WebSocket.OPEN;
    // The send itself is top-level gate I/O (3) — summarized by what it carries
    // (reducer name / table+sid) so the line is meaningful without the payload;
    // the full serialized payload is lowest-level detail (1).
    debug.log(["gate"], `→ ${open ? "send" : "queue"} ${summarize(msg)}`, 3);
    debug.log(["gate"], `→ ${text}`, 1);
    if (open) this.ws!.send(text);
    else this.outbox.push(text);
  }

  private onMessage(data: string): void {
    let msg: GateMsg;
    try {
      msg = JSON.parse(data) as GateMsg;
    } catch {
      debug.warn(["gate"], `← unparseable: ${data.slice(0, 120)}`, 4);
      return;
    }
    // Per-row deliveries and the server-clock heartbeat are the bulk of traffic
    // (lowest detail, 1); the transaction-level replies (applied / call_ok /
    // call_err / error) are top-level gate I/O (3). Summarized with sid/cid so
    // the line stands alone; call replies resolve their cid back to the reducer
    // name via `pending`.
    const reducer =
      msg.t === "call_ok" || msg.t === "call_err"
        ? this.pending.get(msg.cid)?.reducer
        : undefined;
    const flood = msg.t === "row" || msg.t === "time";
    debug.log(["gate"], `← ${summarizeIn(msg, reducer)}`, flood ? 1 : 3);
    if (msg.t === "call_ok") {
      this.pending.get(msg.cid)?.resolve();
      this.pending.delete(msg.cid);
      return;
    }
    if (msg.t === "call_err") {
      this.pending.get(msg.cid)?.reject(new Error(msg.error));
      this.pending.delete(msg.cid);
      return;
    }
    this.dispatch(msg);
  }
}

/** Compact one-line label for an outbound frame — what it carries, not the
 *  whole payload. `call` is keyed by reducer (the thing you actually want to
 *  see fly by); `sub`/`unsub` by table+sid. The full JSON rides the L1 line. */
function summarize(msg: ClientMsg): string {
  switch (msg.t) {
    case "sub":
      return `sub ${msg.table}#${msg.sid}`;
    case "unsub":
      return `unsub #${msg.sid}`;
    case "call":
      return `call ${msg.reducer}`;
  }
}

/** Compact one-line label for an inbound frame — the recv counterpart to
 *  [`summarize`]. Carries the sid/cid so the L3 line stands alone without the
 *  per-sid log the manager used to duplicate. `row` keeps only the sid here
 *  (the manager's L1 line adds the resolved table name). */
function summarizeIn(msg: GateMsg, reducer?: string): string {
  // `reducer` resolves a call reply's cid back to the reducer that's pending on
  // it (see `onMessage`) — `call_ok cid=12 (propose_action)` reads far better
  // than a bare cid. Absent (reply landed after the pending entry was cleared,
  // or non-call frame) we just show the cid.
  const named = (cid: number): string => (reducer ? `${reducer} cid=${cid}` : `cid=${cid}`);
  switch (msg.t) {
    case "applied":
      return `applied sid=${msg.sid}`;
    case "row":
      return `row ${msg.op} #${msg.sid}`;
    case "call_ok":
      return `call_ok ${named(msg.cid)}`;
    case "call_err":
      return `call_err ${named(msg.cid)}`;
    case "error":
      return "error";
    case "time":
      return `time ${msg.server_micros}`;
  }
}

let shared: GateConnection | null = null;
const DEFAULT_GATE_URI = "ws://localhost:8473/ws";

/** The one gate connection for this client, shared by reads
 *  (`GateSubscriptionManager`) and writes (`ReducerManager`). Lazily opened on
 *  first subscribe/call via `ensureConnected`. */
export function sharedGate(): GateConnection {
  if (!shared) {
    shared = new GateConnection(
      (import.meta.env.VITE_GATE_URI as string | undefined) ?? DEFAULT_GATE_URI,
    );
  }
  return shared;
}

/** Tear down the shared gate connection (HMR dispose). Closes the socket if one
 *  was opened and drops the singleton so the next `sharedGate()` builds a fresh
 *  one — no orphaned sockets accumulate across hot reloads. */
export function closeSharedGate(): void {
  shared?.close();
  shared = null;
}
