import type { GameContext } from "../../GameContext";
import type { Card as CardRow } from "../../server/spacetime/bindings/types";
import { packStackMicroZone, type ZoneId } from "../../server/data/packing";
import { Card, type CardPositionState, type StackDirection } from "./Card";
import {
  clearStackedState,
  decodeLooseXY,
  encodeLooseXY,
  getStackedState,
  getStackPosition,
  setStackedState,
  STACKED_LOOSE,
  STACKED_ON_HEX,
  STACKED_ON_RECT_X,
  STACKED_ON_RECT_Y,
} from "./cardData";
// World helpers (packMacroZone, unpackMacroZone, WORLD_LAYER, ZONE_SIZE) live
// in `server/data/packing` — re-import there when world tier is restored.

export type CardChangeKind = "added" | "removed";
export type CardListener = (kind: CardChangeKind, card: Card) => void;
/**
 * Fired when a stack is "modified" — a card joined, left, or changed
 * direction within a chain. Receives the root id of the affected chain in
 * its post-change state. Same root may be reported via two listeners
 * (oldRoot + newRoot) when a card moves between chains.
 */
export type StackChangeListener = (rootId: number) => void;

const FIND_ROOT_MAX_DEPTH = 64;

export class CardManager {
  private readonly cards = new Map<number, Card>();
  private readonly byZone = new Map<ZoneId, Set<Card>>();
  private readonly listeners = new Map<ZoneId, Set<CardListener>>();
  private readonly stackListeners = new Map<ZoneId, Set<StackChangeListener>>();
  private readonly globalStackListeners = new Set<StackChangeListener>();
  private readonly unsubscribe: () => void;
  /** Cards currently being spliced out — suppress fireStackChange for these roots. */
  private readonly splicing = new Set<number>();

  constructor(private readonly ctx: GameContext) {
    for (const cardId of ctx.data.cardsLocal.keys()) {
      this.spawn(cardId);
    }
    // Spawn order is arbitrary so a child may have spawned before its
    // parent and missed setting its back-pointer. Repair once now that
    // every card is in the registry.
    this.repairBackPointers();
    this.unsubscribe = ctx.data.subscribeLocalCard((change) => {
      if (change.kind === "added") this.spawn(change.key);
      else if (change.kind === "removed") this.destroy(change.key);
      // "updated" — same id, position/flag bits changed. Cards subscribe
      // to their own key for data changes; CardManager only cares about
      // spawn/destroy transitions.
    });
  }

  /**
   * Remove `cardId` from its chain, bridging the gap it leaves behind.
   *
   * - State 0 (loose/root): both stacked children are freed to loose positions
   *   offset one title-height above/below the dying card's packed XY.
   * - State 1/2 (mid-chain): the continuation child (same direction as this
   *   card's attachment) inherits this card's `microZone` and `microLocation`
   *   verbatim, transplanting its chain position exactly. The cross child is
   *   left for orphan-detection to recover (uncommon case).
   * - State 3 (hex/world-root): top child becomes the new root; bottom child
   *   is directly re-parented onto the new root's bottom slot.
   */
  spliceCard(cardId: number): void {
    const card = this.cards.get(cardId);
    if (!card) return;
    const row = this.ctx.data.cardsLocal.get(cardId);
    if (!row) return;

    this.splicing.add(cardId);
    const state = getStackedState(row.microZone);

    // World branches stripped — when world tier returns, route
    // `row.surface >= WORLD_LAYER` to a different release path here.

    if (state === STACKED_LOOSE) {
      // Loose root dying. Every chain member had `microLocation = cardId`
      // and now needs re-rooting under whichever survivor we promote.
      const { x, y } = decodeLooseXY(row.microLocation);
      const topMembers = this.collectChainMembers(cardId, STACKED_ON_RECT_X);
      const bottomMembers = this.collectChainMembers(cardId, STACKED_ON_RECT_Y);
      const hexChildId = card.stackedHex;

      let newRootId = 0;
      if (topMembers.length > 0) {
        newRootId = topMembers[0];
        this.setCardPosition(newRootId, { kind: "loose", x, y });
        let parent = newRootId;
        for (let i = 1; i < topMembers.length; i++) {
          this.setCardPosition(topMembers[i], { kind: "stacked", parentId: parent, direction: "top" });
          parent = topMembers[i];
        }
      } else if (bottomMembers.length > 0) {
        newRootId = bottomMembers[0];
        this.setCardPosition(newRootId, { kind: "loose", x, y });
        let parent = newRootId;
        for (let i = 1; i < bottomMembers.length; i++) {
          this.setCardPosition(bottomMembers[i], { kind: "stacked", parentId: parent, direction: "bottom" });
          parent = bottomMembers[i];
        }
      }

      // If we used top members for the new root and there are also
      // bottom members, re-stack the bottom chain onto the new root
      // (each bottom member onto its predecessor, starting from the
      // new root).
      if (topMembers.length > 0 && bottomMembers.length > 0) {
        let parent = newRootId;
        for (const id of bottomMembers) {
          this.setCardPosition(id, { kind: "stacked", parentId: parent, direction: "bottom" });
          parent = id;
        }
      }

      if (hexChildId !== 0) {
        const dest = this.releasedHexChildPosition(row);
        if (dest) this.setCardPosition(hexChildId, dest);
      }
    } else if (state === STACKED_ON_RECT_X || state === STACKED_ON_RECT_Y) {
      // Mid-chain death. `microLocation` is the chain root and stays put
      // for survivors; the only change is renumbering positions down by
      // 1 for every chain member past the gap. Detach the dying card
      // first so it's not at any chain position when we renumber, then
      // walk surviving members in ascending old-position order.
      const dyingPos = getStackPosition(row.microZone);
      const dyingRoot = row.microLocation;
      const renumber: { id: number; oldPos: number }[] = [];
      for (const [id, r] of this.ctx.data.cardsLocal) {
        if (id === cardId) continue;
        if (r.microLocation !== dyingRoot) continue;
        if (getStackedState(r.microZone) !== state) continue;
        const pos = getStackPosition(r.microZone);
        if (pos > dyingPos) renumber.push({ id, oldPos: pos });
      }
      renumber.sort((a, b) => a.oldPos - b.oldPos);

      this.setCardPosition(cardId, { kind: "loose", x: 0, y: 0 });
      for (const { id } of renumber) {
        const r = this.ctx.data.cardsLocal.get(id);
        if (!r) continue;
        const newPos = getStackPosition(r.microZone) - 1;
        this.ctx.data.setLocalCard(id, {
          ...r,
          microZone: packStackMicroZone(newPos, false, state),
        });
      }
    } else if (state === STACKED_ON_HEX) {
      // Hex chains kept on the legacy parent-pointer model; the
      // back-pointer cache here is the source of truth.
      const hexId = row.microLocation;
      const topId = card.stackedTop;
      const bottomId = card.stackedBottom;
      const hexChildId = card.stackedHex;
      if (topId !== 0) {
        this.setCardPosition(topId, { kind: "stacked", parentId: hexId, direction: "hex" });
        if (bottomId !== 0) this.stack(bottomId, topId, "bottom");
      } else if (bottomId !== 0) {
        this.setCardPosition(bottomId, { kind: "stacked", parentId: hexId, direction: "hex" });
      }
      if (hexChildId !== 0) {
        const dest = this.releasedHexChildPosition(row);
        if (dest) this.setCardPosition(hexChildId, dest);
      }
      this.setCardPosition(cardId, { kind: "loose", x: 0, y: 0 });
    }

    card.stackedTop = 0;
    card.stackedBottom = 0;
    card.stackedHex = 0;
    this.splicing.delete(cardId);
  }

  /** Collect every card currently rooted at `rootId` in `direction`,
   *  sorted by `position` ascending. Filters `cardsLocal` directly —
   *  slower than walking the back-pointer cache but tolerates gaps and
   *  is independent of cache state (used by `spliceCard` where the
   *  cache may still hold stale predecessors). `direction` is a
   *  `STACKED_ON_RECT_X` / `STACKED_ON_RECT_Y` value. */
  private collectChainMembers(rootId: number, direction: number): number[] {
    const members: { id: number; pos: number }[] = [];
    for (const [id, r] of this.ctx.data.cardsLocal) {
      if (r.microLocation !== rootId) continue;
      if (getStackedState(r.microZone) !== direction) continue;
      members.push({ id, pos: getStackPosition(r.microZone) });
    }
    members.sort((a, b) => a.pos - b.pos);
    return members.map((m) => m.id);
  }

  /**
   * Where a `STACKED_ON_HEX` child of a dying hex should land. Mirrors the
   * dying hex's own position so the child stays put visually — wherever the
   * hex was, the child takes its place loose:
   *
   *   - hex loose in inventory → child loose at the same `(x, y)`
   *   - hex stacked on another hex (state 3, microLocation=parentId)
   *       → child re-anchors to the same parent hex
   *
   * World cases (hex loose in world, hex on a bare world tile) are stripped
   * for now; they'd return `kind: "world"` positions when world returns.
   */
  private releasedHexChildPosition(row: CardRow): CardPositionState | null {
    const state = getStackedState(row.microZone);
    if (state === STACKED_LOOSE) {
      const { x, y } = decodeLooseXY(row.microLocation);
      return { kind: "inventory", x, y };
    }
    if (state === STACKED_ON_HEX) {
      if (row.microLocation === 0) {
        return null; // would be a world position; stripped
      }
      return { kind: "stacked", parentId: row.microLocation, direction: "hex" };
    }
    return null;
  }

  /**
   * Stack card `aId` onto card `bId` in the given direction.
   *
   * Invariant guarded here: A's chain (the dragged card and its descendants)
   * must be uniform in `direction` after the operation, so the resulting
   * chain rooted at A — which becomes a sub-chain of B's chain — doesn't
   * have mixed top/bottom links. Three cases on A:
   *
   *   1. A has both top AND bottom children → reject. There's no consistent
   *      single direction we could flip A's chain to without losing one
   *      side, so we refuse the stack.
   *
   *   2. A has children in the *opposite* direction → flip A's entire chain
   *      to match `direction`. Each card stays stacked on the same parent;
   *      only its flag bits flip (top↔bottom) and the titlebar swaps. B is
   *      unconstrained — if B already has its opposite slot occupied, A's
   *      chain simply attaches in the requested slot and B ends up with a
   *      "Y" of children, which is allowed.
   *
   *   3. A has children in the requested direction (or no children) → no
   *      flip needed; A's chain comes along uniformly.
   *
   * After flip (if any), walks B's chain in `direction` to find the leaf
   * and stacks A there. The walk validates each pointer against current
   * data and repairs stale pointers in place — `Card.setPosition` does the
   * data write and back-pointer plumbing flows through onDataChange.
   */
  stack(aId: number, bId: number, direction: StackDirection): void {
    const a = this.cards.get(aId);
    if (!a) return;
    if (!this.cards.get(bId)) return;

    const oppositeDir: StackDirection = direction === "top" ? "bottom" : "top";
    const aRequestedSlot = this.slot(aId, direction);
    const aOppositeSlot = this.slot(aId, oppositeDir);

    if (aRequestedSlot !== 0 && aOppositeSlot !== 0) return;

    if (aRequestedSlot === 0 && aOppositeSlot !== 0) {
      this.flipChain(aId, oppositeDir, direction);
    }

    let leafId = bId;
    while (true) {
      const leaf = this.cards.get(leafId);
      if (!leaf) return;
      // Self-stack check: if A is already in B's chain at this slot,
      // the stack is a no-op and we'd loop infinitely otherwise.
      const raw = direction === "top" ? leaf.stackedTop : leaf.stackedBottom;
      if (raw === aId) break;
      const next = this.slot(leafId, direction);
      if (next === 0) break;
      leafId = next;
    }

    // Collect A's chain in `direction` BEFORE moving A — once A's row
    // changes, A's children still point at A as root (microLocation = aId)
    // so they're discoverable by walking the back-pointer cache from A.
    // After A's microLocation flips to B's root, the children's chain-
    // root reference is stale; we re-stack each one onto its predecessor
    // so `setCardPosition` re-computes its (root_id, position) from the
    // freshly-written predecessor row.
    const aChain: number[] = [];
    {
      let cursor = aId;
      while (true) {
        const next = this.slot(cursor, direction);
        if (next === 0) break;
        aChain.push(next);
        cursor = next;
      }
    }

    this.setCardPosition(aId, { kind: "stacked", parentId: leafId, direction });

    let parentForChild = aId;
    for (const childId of aChain) {
      this.setCardPosition(childId, { kind: "stacked", parentId: parentForChild, direction });
      parentForChild = childId;
    }
  }

  /**
   * Build a client-side position update for `cardId`. The row is read from
   * the data store, the position fields are replaced. The actual write-back
   * is currently a no-op while the new architecture's outbound path is
   * still being wired — a reducer call (e.g. `ctx.reducers.setMicroLocation`)
   * will replace `setClientCard` here. Until that lands, position changes
   * built here don't propagate.
   */
  setCardPosition(cardId: number, state: CardPositionState): void {
    const row = this.ctx.data.cardsLocal.get(cardId);
    if (!row) return;
    let newRow: CardRow;
    if (state.kind === "loose") {
      newRow = {
        ...row,
        microLocation: encodeLooseXY(state.x, state.y),
        microZone: clearStackedState(row.microZone),
      };
    } else if (state.kind === "inventory") {
      newRow = {
        ...row,
        macroZone: row.ownerId,
        surface: 1,
        microLocation: encodeLooseXY(state.x, state.y),
        microZone: clearStackedState(row.microZone),
      };
    } else if (state.kind === "stacked") {
      const stateBits =
        state.direction === "top" ? STACKED_ON_RECT_X :
        state.direction === "bottom" ? STACKED_ON_RECT_Y :
        STACKED_ON_HEX;
      const parentRow = this.ctx.data.cardsLocal.get(state.parentId);
      if (state.direction === "hex" || stateBits === STACKED_ON_HEX) {
        // Hex chains keep the legacy parent-pointer model.
        newRow = {
          ...row,
          macroZone:     parentRow?.macroZone ?? row.macroZone,
          surface:       parentRow?.surface   ?? row.surface,
          microLocation: state.parentId,
          microZone:     setStackedState(row.microZone, stateBits),
        };
      } else {
        // Rect chains use the (root_id, position) model. Translate the
        // caller's "I'm stacking on `parentId`" into "my chain root is
        // R; my position is P+1 above the parent's position (or 1 if
        // the parent IS the root)". forceFlag = false: this is a
        // client-driven write, server isn't forcing anything.
        let rootId: number;
        let position: number;
        if (parentRow !== undefined) {
          const parentState = getStackedState(parentRow.microZone);
          if (parentState === STACKED_ON_RECT_X || parentState === STACKED_ON_RECT_Y) {
            rootId = parentRow.microLocation;
            position = getStackPosition(parentRow.microZone) + 1;
          } else {
            // Parent is loose root (or hex-mounted, which we don't
            // chain past). Use the parent itself as chain root.
            rootId = state.parentId;
            position = 1;
          }
        } else {
          rootId = state.parentId;
          position = 1;
        }
        newRow = {
          ...row,
          macroZone:     parentRow?.macroZone ?? row.macroZone,
          surface:       parentRow?.surface   ?? row.surface,
          microLocation: rootId,
          microZone:     packStackMicroZone(position, false, stateBits),
        };
      }
    } else {
      // World position — stripped while world tier is gone. Restore the
      // packMacroZone / packMicroZone path from `server/data/packing` here
      // when world returns.
      return;
    }
    // Local-only write: store the new row in DataManager's local overlay.
    // The server tier (`data.cards.server` / `data.cards.current`) is left
    // untouched — pixel placement in inventory is a client concern.
    // `setLocalCard` fires the local-cards subscribers, so the matching
    // `Card.onDataChange` runs and applies the row to both halves
    // (gameCard + layoutCard). It also marks the key as overridden so
    // subsequent server pushes don't clobber the position fields (see
    // `mirrorCard`).
    this.ctx.data.setLocalCard(cardId, newRow);
  }

  get(cardId: number): Card | undefined {
    return this.cards.get(cardId);
  }

  size(): number {
    return this.cards.size;
  }

  /** Snapshot iterator of cards currently in the given zone. */
  *cardsInZone(zoneId: ZoneId): Generator<Card> {
    const bucket = this.byZone.get(zoneId);
    if (bucket) yield* bucket;
  }

  /**
   * Per-zone delivery. Listener fires `("added", card)` when a card enters
   * the zone (spawned-into or moved-into) and `("removed", card)` when it
   * leaves (destroyed or moved-out). No snapshot of existing cards on
   * subscribe — call `cardsInZone(zoneId)` for an initial scan.
   */
  subscribe(zoneId: ZoneId, listener: CardListener): () => void {
    return this.addListener(this.listeners, zoneId, listener);
  }

  /**
   * Per-zone delivery of stack-change events. Listener receives the root id
   * of an affected chain in the requested zone. `Card.onDataChange` fires
   * here when its parent or stack-direction changes — once for the old
   * chain's root (if applicable), once for the new chain's root (deduped if
   * they're the same). Loose-to-loose moves do NOT fire — those aren't
   * stack changes.
   *
   * Subscribers should walk the chain from `rootId` themselves to discover
   * the cards in it. Chains are uniform-direction by invariant, so walking
   * `stackedTop` xor `stackedBottom` from root finds every card in O(depth).
   */
  subscribeStackChange(zoneId: ZoneId, listener: StackChangeListener): () => void {
    return this.addListener(this.stackListeners, zoneId, listener);
  }

  subscribeAllStackChanges(listener: StackChangeListener): () => void {
    this.globalStackListeners.add(listener);
    return () => this.globalStackListeners.delete(listener);
  }

  /**
   * Fire stack-change listeners for the chain rooted at `rootId`. Called
   * by `Card.onDataChange` after a parent/direction transition. Determines
   * the zone from the root card's current zoneId; listeners registered for
   * that zone hear the event.
   */
  fireStackChange(rootId: number): void {
    if (this.splicing.has(rootId)) return;
    const root = this.cards.get(rootId);
    if (!root) return;
    const zoneId = root.zoneId();
    const set = this.stackListeners.get(zoneId);
    if (set) {
      for (const listener of set) {
        try {
          listener(rootId);
        } catch (err) {
          console.error("[CardManager] stack-change listener threw", err);
        }
      }
    }
    for (const listener of this.globalStackListeners) {
      try {
        listener(rootId);
      } catch (err) {
        console.error("[CardManager] stack-change listener threw", err);
      }
    }
  }

  /**
   * Resolve the loose root of `cardId`'s chain.
   *
   * - Rect chains (state = `STACKED_ON_RECT_X` / `STACKED_ON_RECT_Y`):
   *   one read — `microLocation` IS the root id under the new layout.
   *   Falls back to the card itself if the named root isn't in the
   *   overlay (broken chain).
   * - Hex chains (state = `STACKED_ON_HEX`): walk up via parent pointers
   *   the legacy way until we hit a loose card. Bounded by
   *   `FIND_ROOT_MAX_DEPTH` against pathological cycles.
   * - Loose: returns the card itself.
   */
  rootOf(cardId: number): number {
    const row = this.ctx.data.cardsLocal.get(cardId);
    if (!row) return cardId;
    const state = getStackedState(row.microZone);
    if (state === STACKED_LOOSE) return cardId;
    if (state === STACKED_ON_RECT_X || state === STACKED_ON_RECT_Y) {
      return this.cards.get(row.microLocation) ? row.microLocation : cardId;
    }
    // STACKED_ON_HEX: legacy walk.
    let id = cardId;
    for (let i = 0; i < FIND_ROOT_MAX_DEPTH; i++) {
      const r = this.ctx.data.cardsLocal.get(id);
      if (!r) return id;
      if (getStackedState(r.microZone) !== STACKED_ON_HEX) return id;
      const parentId = r.microLocation;
      if (!this.cards.get(parentId)) return id;
      id = parentId;
    }
    return id;
  }

  /**
   * Re-route a Card between zone buckets. Called by `Card` itself when its
   * data update changes `(macroZone, layer)`. Same Card instance preserved —
   * no destroy/respawn, gameCard / renderCard state survives.
   */
  move(cardId: number, oldZoneId: ZoneId, newZoneId: ZoneId): void {
    if (oldZoneId === newZoneId) return;
    const card = this.cards.get(cardId);
    if (!card) return;
    this.removeFromZone(oldZoneId, card);
    this.addToZone(newZoneId, card);
  }

  dispose(): void {
    this.unsubscribe();
    for (const card of this.cards.values()) card.destroy();
    this.cards.clear();
    this.byZone.clear();
    this.listeners.clear();
    this.stackListeners.clear();
  }

  private spawn(cardId: number): void {
    if (this.cards.has(cardId)) return;
    const card = Card.create(cardId, this.ctx, this);
    if (!card) return;
    this.cards.set(cardId, card);
    this.addToZone(card.zoneId(), card);
    // [diag] spawn — investigating teleport-on-stack repro.
    const row = this.ctx.data.cardsLocal.get(cardId);
    console.log(
      `[diag] spawn id=${cardId} state=${row ? (row.microZone & 0x3) : "-"} mz=${row?.microZone ?? "-"} ml=${row?.microLocation ?? "-"} flags=${row?.flags ?? "-"}`,
    );
  }

  private destroy(cardId: number): void {
    const card = this.cards.get(cardId);
    if (!card) return;
    // [diag] destroy.
    console.log(`[diag] destroy id=${cardId}`);
    this.removeFromZone(card.zoneId(), card);
    card.destroy();
    this.cards.delete(cardId);
  }

  private addToZone(zoneId: ZoneId, card: Card): void {
    let bucket = this.byZone.get(zoneId);
    if (!bucket) {
      bucket = new Set();
      this.byZone.set(zoneId, bucket);
    }
    bucket.add(card);
    this.fireZone(zoneId, "added", card);
  }

  private removeFromZone(zoneId: ZoneId, card: Card): void {
    const bucket = this.byZone.get(zoneId);
    if (bucket) {
      bucket.delete(card);
      if (bucket.size === 0) this.byZone.delete(zoneId);
    }
    this.fireZone(zoneId, "removed", card);
  }

  private addListener<L>(
    map: Map<ZoneId, Set<L>>,
    zoneId: ZoneId,
    listener: L,
  ): () => void {
    let set = map.get(zoneId);
    if (!set) {
      set = new Set();
      map.set(zoneId, set);
    }
    set.add(listener);
    return () => {
      const s = map.get(zoneId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) map.delete(zoneId);
    };
  }

  /**
   * Read the immediate child stacked on `parentId` in `direction`, or 0
   * if the cache says none. The back-pointer cache is maintained from
   * data by `Card.onDataChange` (via `Card.stackParentOf` which resolves
   * to the immediate parent under the stack layout), so a direct read
   * is trustworthy — no validation/repair pass needed.
   */
  private slot(parentId: number, direction: StackDirection): number {
    const parent = this.cards.get(parentId);
    if (!parent) return 0;
    if (direction === "top") return parent.stackedTop;
    if (direction === "bottom") return parent.stackedBottom;
    return parent.stackedHex;
  }

  /**
   * Walks the chain rooted at `rootId` in `fromDir` and rewrites every
   * link to `toDir`. Each chain member's `stackedState` bits flip; the
   * `position` field is rebuilt from 1..N in walk order so position 1
   * stays adjacent to root after the flip.
   *
   * Collects ids first via the back-pointer cache so each setCardPosition
   * sees a coherent pre-flip view. Each write fires onDataChange and
   * shuffles the cache; by loop end the chain is uniform in `toDir`.
   */
  private flipChain(
    rootId: number,
    fromDir: StackDirection,
    toDir: StackDirection,
  ): void {
    const chain: number[] = [];
    let currentId = rootId;
    while (true) {
      const childId = this.slot(currentId, fromDir);
      if (childId === 0) break;
      chain.push(childId);
      currentId = childId;
    }
    // Walk the collected chain in order and re-stack each one onto its
    // predecessor in `toDir`. setCardPosition recomputes the position
    // field from the parent's row, so positions naturally renumber 1..N.
    let parentId = rootId;
    for (const id of chain) {
      this.setCardPosition(id, {
        kind: "stacked",
        parentId,
        direction: toDir,
      });
      parentId = id;
    }
  }

  /** Rebuild back-pointer cache from data. Called once after the
   *  initial spawn pass — spawn order is arbitrary, so a child may have
   *  spawned before its parent and missed the immediate-parent's
   *  `Card.stackedTop` setter. After every chain mutation, individual
   *  `Card.onDataChange` runs maintain the cache incrementally; this
   *  pass is the start-of-life seed. */
  private repairBackPointers(): void {
    for (const card of this.cards.values()) {
      const row = this.ctx.data.cardsLocal.get(card.cardId);
      if (!row) continue;
      const state = getStackedState(row.microZone);
      if (state !== STACKED_ON_RECT_X && state !== STACKED_ON_RECT_Y && state !== STACKED_ON_HEX) {
        continue;
      }
      // Resolve immediate parent: for hex, microLocation IS the parent.
      // For rect chains, the immediate parent is the card at position-1
      // in the same direction (or the chain root if position == 1).
      let parentId: number;
      if (state === STACKED_ON_HEX) {
        parentId = row.microLocation;
      } else {
        const position = getStackPosition(row.microZone);
        if (position <= 1) {
          parentId = row.microLocation;
        } else {
          parentId = 0;
          for (const [otherId, otherRow] of this.ctx.data.cardsLocal) {
            if (otherRow.microLocation !== row.microLocation) continue;
            if (getStackedState(otherRow.microZone) !== state) continue;
            if (getStackPosition(otherRow.microZone) === position - 1) {
              parentId = otherId;
              break;
            }
          }
          if (parentId === 0) parentId = row.microLocation;
        }
      }
      const parent = this.cards.get(parentId);
      if (!parent) continue;
      if (state === STACKED_ON_RECT_X) parent.stackedTop = card.cardId;
      else if (state === STACKED_ON_RECT_Y) parent.stackedBottom = card.cardId;
      else parent.stackedHex = card.cardId;
    }
  }

  private fireZone(zoneId: ZoneId, kind: CardChangeKind, card: Card): void {
    const set = this.listeners.get(zoneId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(kind, card);
      } catch (err) {
        console.error("[CardManager] zone listener threw", err);
      }
    }
  }
}
