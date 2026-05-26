import type { SubscriptionHandleImpl } from "spacetimedb";
import { debug } from "../../debug";
import type { ConnectionManager } from "./ConnectionManager";

type AnySubscriptionHandle = SubscriptionHandleImpl<any>;

interface SubscriptionDef {
  queries: string[];
  scopeKey: string;
}

interface ActiveSubscription {
  name: string;
  def: SubscriptionDef;
  handle: AnySubscriptionHandle | null;
  inFlight: Promise<void> | null;
}

export interface TableHandlers<T> {
  onInsert?: (row: T) => void;
  onUpdate?: (oldRow: T, newRow: T) => void;
  onDelete?: (row: T) => void;
}

/**
 * Generic subscription lifecycle base shared by ShardSubscriptionManager and
 * ChatSubscriptionManager. Owns the subscription registry, the table-handler
 * fan-out, reconnect / re-issue logic, and the reducer-timestamp hook.
 *
 * Subclasses implement `bindHandlers(conn)` to wire the SDK's per-table
 * callbacks for their module, and expose typed `subscribeXxx` helpers
 * that call the protected `installSubscription` / `removeSubscription`
 * methods.
 *
 * TConn      — the module-specific DbConnection type (ShardDbConnection or
 *              ChatDbConnection).
 * TTableRowMap — record mapping table-name strings to their row types.
 *              Constrains `registerTableHandlers` and `fanOut`.
 */
export abstract class SubscriptionBase<
  TConn,
  TTableRowMap extends Record<string, unknown>,
> {
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly handlers = new Map<
    keyof TTableRowMap,
    Set<TableHandlers<any>>
  >();
  private readonly removeConnectionListener: () => void;
  protected readonly onReducerEvent?: (microsSinceUnixEpoch: bigint) => void;

  constructor(
    protected readonly connection: ConnectionManager<TConn>,
    options?: { onReducerEvent?: (microsSinceUnixEpoch: bigint) => void },
  ) {
    this.onReducerEvent = options?.onReducerEvent;
    this.removeConnectionListener = this.connection.addListener({
      onConnected: (conn) => {
        this.bindHandlers(conn);
        void this.reissueAllSubscriptions();
      },
      onDisconnected: () => {
        for (const sub of this.subscriptions.values()) {
          sub.handle = null;
        }
      },
    });
  }

  /** Subclasses wire the module-specific SDK row callbacks here.
   *  Called once on every successful connect (including reconnects). */
  protected abstract bindHandlers(conn: TConn): void;

  /** Tear down: drop the connection listener, unsubscribe every active
   *  subscription, clear the registry and handler map. */
  dispose(): void {
    this.removeConnectionListener();
    for (const sub of this.subscriptions.values()) {
      if (sub.handle?.isActive()) sub.handle.unsubscribe();
    }
    this.subscriptions.clear();
    this.handlers.clear();
  }

  /** Register insert/update/delete handlers for a table. Multiple
   *  registrations for the same table all fire in order. Returns an
   *  unregister fn. */
  registerTableHandlers<K extends keyof TTableRowMap>(
    table: K,
    handlers: TableHandlers<TTableRowMap[K]>,
  ): () => void {
    let set = this.handlers.get(table);
    if (!set) {
      set = new Set();
      this.handlers.set(table, set);
    }
    set.add(handlers as TableHandlers<any>);
    return () => {
      set!.delete(handlers as TableHandlers<any>);
    };
  }

  protected async installSubscription(
    name: string,
    def: SubscriptionDef,
  ): Promise<void> {
    const existing = this.subscriptions.get(name);

    if (existing && existing.def.scopeKey === def.scopeKey) {
      if (existing.inFlight) {
        debug.log(
          ["spacetime"],
          `[spacetime] sub "${name}" already in flight, waiting`,
          2,
        );
        return existing.inFlight;
      }
      if (existing.handle?.isActive()) {
        debug.log(
          ["spacetime"],
          `[spacetime] sub "${name}" already active, skipping`,
          2,
        );
        return;
      }
    }

    if (existing?.handle?.isActive()) existing.handle.unsubscribe();

    debug.log(
      ["spacetime"],
      `[spacetime] installing sub "${name}" scope=${def.scopeKey}`,
      3,
    );

    const sub: ActiveSubscription = { name, def, handle: null, inFlight: null };
    this.subscriptions.set(name, sub);

    const inFlight = this.openSubscription(sub);
    sub.inFlight = inFlight;
    try {
      await inFlight;
    } finally {
      sub.inFlight = null;
    }
  }

  protected removeSubscription(name: string): void {
    const sub = this.subscriptions.get(name);
    if (!sub) return;
    debug.log(["spacetime"], `[spacetime] removing sub "${name}"`, 3);
    if (sub.handle?.isActive()) sub.handle.unsubscribe();
    this.subscriptions.delete(name);
  }

  private async openSubscription(sub: ActiveSubscription): Promise<void> {
    debug.log(
      ["spacetime"],
      `[spacetime] opening sub "${sub.name}" queries=${sub.def.queries.join(" | ")}`,
      2,
    );
    sub.handle = await this.subscribeRaw(sub.def.queries);
    debug.log(["spacetime"], `[spacetime] sub "${sub.name}" applied`, 3);
  }

  private async subscribeRaw(queries: string[]): Promise<AnySubscriptionHandle> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = await (this.connection.connect() as Promise<any>);
    return new Promise<AnySubscriptionHandle>((resolve, reject) => {
      let handle: AnySubscriptionHandle | undefined;
      handle = conn
        .subscriptionBuilder()
        .onApplied(() => {
          if (handle) resolve(handle);
          else
            reject(
              new Error(
                "[spacetime] subscription applied before handle was assigned",
              ),
            );
        })
        .onError((ctx: unknown) => {
          const event = (ctx as { event?: { error?: unknown } } | undefined)
            ?.event;
          const detail = event?.error;
          const message = `subscription error (${queries.join(" | ")}): ${
            detail instanceof Error
              ? detail.message
              : detail !== undefined
                ? String(detail)
                : "no detail from SDK"
          }`;
          reject(detail instanceof Error ? detail : new Error(message));
        })
        .subscribe(queries);
    });
  }

  private async reissueAllSubscriptions(): Promise<void> {
    const subs = Array.from(this.subscriptions.values());
    debug.log(
      ["spacetime"],
      `[spacetime] reissuing ${subs.length} subscription(s) after reconnect`,
      4,
    );
    await Promise.all(
      subs.map(async (sub) => {
        debug.log(["spacetime"], `[spacetime] reissuing sub "${sub.name}"`, 3);
        sub.handle = null;
        const inFlight = this.openSubscription(sub);
        sub.inFlight = inFlight;
        try {
          await inFlight;
        } catch (err) {
          debug.log(
            ["spacetime"],
            `[spacetime] re-subscribe "${sub.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
            4,
          );
          console.error(`[spacetime] re-subscribe ${sub.name} failed`, err);
        } finally {
          sub.inFlight = null;
        }
      }),
    );
  }

  protected captureReducerTimestamp(ctx: { event?: any }): void {
    if (!this.onReducerEvent) return;
    const event = ctx.event;
    if (!event || event.tag !== "Reducer") return;
    const micros = event.value?.timestamp?.microsSinceUnixEpoch;
    if (typeof micros === "bigint") this.onReducerEvent(micros);
  }

  protected fanOut<K extends keyof TTableRowMap>(
    table: K,
    op: string,
    fn: (h: TableHandlers<TTableRowMap[K]>) => void,
  ): void {
    const set = this.handlers.get(table);
    if (!set) return;
    for (const h of set) {
      try {
        fn(h as TableHandlers<TTableRowMap[K]>);
      } catch (err) {
        console.error(`[spacetime] ${String(table)}.${op} handler threw`, err);
      }
    }
  }
}
