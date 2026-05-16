/**
 * Parsed representation of the server's `magnetic_blocked:` error
 * response, returned from `proposeAction` / `addCard` / `createCharacter`
 * / `deployMiniZone` when the caller has expired magnetic actions that
 * haven't been resolved.
 *
 * Server format (see `magnetic_pending::block_check` in the shard
 * module):
 *
 * ```text
 * magnetic_blocked: card_id=<n>; expires_at_ms=<n>; overdue_ms=<n>
 * ```
 *
 * One offending card per error — the earliest-expiring one. Once the
 * client resolves that card, the next call surfaces the next-earliest
 * (or succeeds if there are no more expired actions).
 */
export interface LifecycleBlockedError {
  /** The card_id the client must resolve before progressing. */
  readonly cardId: number;
  /** Absolute wall-clock ms at which the magnetic phase ended. */
  readonly expiresAtMs: bigint;
  /** How long past `expiresAtMs` we are, server-side. */
  readonly overdueMs: bigint;
}

const PREFIX = "magnetic_blocked:";

/**
 * Try to parse an error from a SpacetimeDB reducer call as a
 * `LifecycleBlockedError`. Returns `null` if the error doesn't carry
 * the magnetic-block prefix — caller falls back to generic
 * error handling in that case.
 *
 * The SpacetimeDB TS SDK rejects reducer promises with whatever the
 * server's `Err(String)` was. Callers typically catch as `unknown`
 * or `Error`; this helper accepts both.
 */
export function parseLifecycleBlockedError(err: unknown): LifecycleBlockedError | null {
  const msg = errorToString(err);
  if (!msg.startsWith(PREFIX)) return null;
  // Format: "magnetic_blocked: card_id=N; expires_at_ms=M; overdue_ms=O"
  const rest = msg.slice(PREFIX.length);
  const cardId = extractNumber(rest, "card_id=");
  const expiresAtMs = extractBigInt(rest, "expires_at_ms=");
  const overdueMs = extractBigInt(rest, "overdue_ms=");
  if (cardId === null || expiresAtMs === null || overdueMs === null) {
    return null;
  }
  return { cardId, expiresAtMs, overdueMs };
}

function errorToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

function extractNumber(s: string, key: string): number | null {
  const i = s.indexOf(key);
  if (i < 0) return null;
  const start = i + key.length;
  const end = findValueEnd(s, start);
  const n = Number(s.slice(start, end));
  return Number.isFinite(n) ? n : null;
}

function extractBigInt(s: string, key: string): bigint | null {
  const i = s.indexOf(key);
  if (i < 0) return null;
  const start = i + key.length;
  const end = findValueEnd(s, start);
  try {
    return BigInt(s.slice(start, end));
  } catch {
    return null;
  }
}

/** Find the end of a numeric token starting at `start` — first
 *  non-digit / non-minus character or end-of-string. */
function findValueEnd(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    // 0-9 or '-'
    if ((c >= 48 && c <= 57) || c === 45) {
      i++;
    } else {
      break;
    }
  }
  return i;
}
