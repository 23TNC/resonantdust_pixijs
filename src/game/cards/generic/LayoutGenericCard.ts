import type { Card as CardRow } from "../../../server/spacetime/bindings/types";
import type { LocalCard } from "../../../server/data/DataManager";
import type { GameContext } from "../../../GameContext";
import { ownerFactionFolder } from "../../../server/player/playerFlags";
import { isSlotHeld } from "../../actions/chainState";
import { LayoutCard } from "../layout/CardLayout";
import type { LayoutNode } from "../../layout/LayoutNode";
import { global } from "../../definitions/globals";
import { decodeMicro } from "../../../server/data/packing";
import { directionForBranch } from "../cardData";
import { cardBox } from "./cardBox";
import { atlasHex, atlasWhite } from "./atlasFills";
import { PrimitiveLayer } from "./PrimitiveLayer";
import type { PrimDeps } from "./primitives";
import { drawVisuals, type VisualHost, type HostValue } from "./drawVisuals";
import type { PrimList } from "./visualSpec";
import { debug } from "../../../debug";

/**
 * The DSL-driven card, slotting into the existing `Card` lifecycle as the
 * visual ("Layout") half. Extends `LayoutCard` to reuse all the shared
 * plumbing — `tweenTo` position animation, drag offset, stack hosts, attach —
 * and replaces only the bespoke visual build (the `rectVisual`/`progressBar`/
 * `resourceMeter`/… sub-layers of `LayoutRectCard`) with a `PrimitiveLayer`
 * reconciled from a `PrimList`.
 *
 * `layout()` is the same shape as `LayoutRectCard`'s positioning tail —
 * `tweenTo(target, with drag)` — plus `layer.settle()` for the primitive ease;
 * returning `true` from either keeps the LayoutNode dirty loop running (no
 * ticker). The spec rebuilds only on data change (`applyData`) / resize.
 *
 * **Scope today:** loose / unstacked cards (first live def: requisite `axe`).
 * Stack positioning (`chainStep`) is shape-specific and deferred until a stacked
 * card is migrated — at which point the generic stack model is decided (likely
 * DSL-driven). The spec comes from the wasm `:visuals` export (`rebuildSpec` →
 * `drawVisuals`); `setSpec` allows direct injection (preview paths).
 */
export class LayoutGenericCard extends LayoutCard {
  private readonly layer: PrimitiveLayer;
  private readonly deps: PrimDeps;
  private spec: PrimList | null = null;
  private currentPackedDefinition: number | null = null;
  /** Last row applied — the source for `^card_data` (stack state/index, …). */
  private currentRow: CardRow | null = null;
  /** First draw runs the `:visuals @init` hook (client snaps current=target);
   *  subsequent data changes run `@update` (client eases to new targets). */
  private drawn = false;
  /** Visual y-offset the DSL applies to this card's prims for its place in the
   *  stack fan (`index · dir · title_height`). The card CONTAINER sits at the
   *  root (0,0); only the prims move — so hit-testing must shift by this to
   *  follow the visible card (see `intersects`). 0 when loose. */
  private stackOffsetY = 0;
  /** Which side this card's title bar sits on — true = above the body, false =
   *  below. Top-stack members + the loose root show it above; bottom-stack members
   *  below. Drives the hit-test extent (the bar is a strip OUTSIDE the body now). */
  private titleTop = true;
  /** True once `dead === 1` has begun the exit: we've run `:visuals @destroy`
   *  and are easing the prims to their exit targets. When the layer settles,
   *  `layout()` splices the chain + writes `dead: 2` (→ CardManager tears us
   *  down). A card with no `@destroy` hook emits no prims → instant removal. */
  private destroying = false;

  constructor(cardId: number, ctx: GameContext) {
    super(cardId, ctx);
    // The card BOX is the body — `card_width × body_height` (the 72×72 square);
    // the title bar is a separate strip OUTSIDE the body (handled in the DSL +
    // `intersects`). Sizes come from the DSL `<globals>`, not hardcoded constants.
    this.setSize(global("card_width"), global("body_height"));
    this.deps = {
      lod: ctx.lodTextures,
      whiteTexture: atlasWhite(ctx.textures, ctx.app.renderer),
      hexTexture: atlasHex(ctx.textures, ctx.app.renderer),
      seed: cardId,
      // Live progress fill for `^progress` prims — the engine reads the tracked
      // row's timing vs the server clock each frame (the DSL only set `target`).
      progress: (target) => this.progressFraction(target),
      // Live fill for a `source = 1` (queue) `^progress` prim: the action
      // queue/debounce countdown before this card's recipe is proposed.
      queue: () => this.ctx.actions?.progressFor(this.cardId) ?? -1,
    };
    this.layer = new PrimitiveLayer(cardBox(this.width, this.height), this.deps);
    // Above the stack hosts the base added in its constructor.
    this.container.addChild(this.layer);
  }

  applyData(row: CardRow): void {
    this.currentPackedDefinition = row.packedDefinition;
    this.currentRow = row;
    // Death: `dead === 1` is the dying grace window. Run the DSL `@destroy` exit
    // ONCE (unless the card is held mid-recipe — then it lives until released),
    // then ease + finalize in `layout()`. A card with no `@destroy` hook emits
    // an empty prim list → instant removal.
    if (
      !this.destroying &&
      (row as LocalCard).dead === 1 &&
      !isSlotHeld(this.ctx, row.cardId, row.flags)
    ) {
      this.destroying = true;
      this.rebuildSpec("destroy");
      this.invalidate();
      return;
    }
    if (this.destroying) return; // exit in flight — ignore further data churn
    this.rebuildSpec(this.drawn ? "update" : "init");
    this.applyPosition(row);
    this.invalidate();
  }

  /** Decode the row's placement and set the tween target — without this the card
   *  sits at (0,0) and never appears in its cell. Mirror of the position half of
   *  `LayoutRectCard.applyData` (the death/flags/overlay decorations are
   *  rect-specific and omitted). LOOSE is handled fully; STACKED fans by the
   *  gap-collapsed `chainStep` (drag-aware), same as the rect chain. */
  private applyPosition(row: CardRow): void {
    const micro = decodeMicro(row.microLocation, row.flags);
    if (micro.kind === "loose") {
      this.stackZ = null;
      this.stackOffsetY = 0;
      this.titleTop = true; // a loose root shows its title bar on top
      const q = row.macroZone.zoneQ + micro.localQ;
      const r = row.macroZone.zoneR + micro.localR;
      const cell = this.worldView?.cellToPixel(q, r);
      const applyOffset = (micro.looseKind & 0b10) === 0;
      const ox = applyOffset ? micro.x : 0;
      const oy = applyOffset ? micro.y : 0;
      if (cell) {
        // Centre the BODY square on the cell (body_height, not the taller total) —
        // the title strip then sticks out above/below the cell.
        this.setTarget((cell.x + ox) - global("card_width") / 2, (cell.y + oy) - global("body_height") / 2);
      } else {
        this.setTarget(micro.x, micro.y);
      }
      return;
    }
    // Stacked: parented to the root's stack host by `CardView.attach`, which
    // carries it for the root's drag/tween. The card sits AT the root (0,0); the
    // visual fan is offset in the DSL prims by `*d.stack.index` (rect_card /
    // hex_card), so the engine no longer moves the container per index. We keep
    // the signed stackZ for card-level paint order and mirror the prim offset in
    // `stackOffsetY` so hit-testing follows the visible card.
    const dir = directionForBranch(micro.branch);
    const sign = dir === "bottom" ? 1 : dir === "top" ? -1 : 0;
    // Visual depth = the card's 1-indexed position in the LIVE chain, NOT the raw
    // `micro.index`: raw is 0-indexed and gappy. `chainStep` collapses gaps +
    // skips draggers. Root in front: members behind it, closest-to-root on top →
    // `-step`. A bottom-stack member shows its title BELOW the body.
    const step = this.chainStep(micro.root, micro.branch, micro.index);
    this.titleTop = dir !== "bottom";
    // Offset in title-bar bands: a TOP member clears the root's top title bar
    // (`step`); a BOTTOM member doesn't (`step-1`). Must match `stack_layout`.
    const units = dir === "bottom" ? step - 1 : step;
    this.stackZ = -step;
    this.stackOffsetY = units * sign * global("title_height");
    this.setTarget(0, 0);
    // The container stays at (0,0) every restack, so `setTarget` won't call
    // `setBounds` to refresh zIndex when only `step` changed (sibling removed).
    // Apply the new paint order explicitly.
    this.zIndex = this.stackZ;
  }

  /** The card's 1-indexed depth in its live chain branch — the gap-collapsed,
   *  drag-aware fan position. Mirrors `LayoutRectCard.chainStep`: walk the chain
   *  (ordered closest-to-root first), skip members being dragged out, and return
   *  this card's rank. While WE are dragging, skip the O(n) walk (cursor-follow
   *  overrides position anyway) and use the raw index. Falls back to `rawIndex+1`
   *  if we're not found (shouldn't happen). */
  private chainStep(rootId: number, branch: number, rawIndex: number): number {
    if (this.state.dragging) return rawIndex + 1;
    const chain = this.ctx.cards?.buildChain(rootId, branch);
    if (!chain) return rawIndex + 1;
    let rank = 0;
    for (const member of chain) {
      if (member.cardId !== this.cardId && member.isDragging()) continue;
      rank++;
      if (member.cardId === this.cardId) return rank;
    }
    return rawIndex + 1;
  }

  /** Hit-test against the card's VISIBLE box = the body PLUS the title bar strip,
   *  which now sits OUTSIDE the body (flush above when `titleTop`, else below).
   *  Shifted by `stackOffsetY` because while stacked the container sits at the
   *  root (0,0) and the prims are fanned by that offset. */
  protected override intersects(localX: number, localY: number): boolean {
    const t = global("title_height");
    const y = localY - this.stackOffsetY;
    const top = this.titleTop ? -t : 0;
    const bottom = this.titleTop ? this.height : this.height + t;
    return localX >= 0 && localX < this.width && y >= top && y < bottom;
  }

  /** Resolve a hit to the card painted ON TOP. The base checks stack-host
   *  children BEFORE self, which is wrong for our root-in-front model: a root's
   *  own body paints over its stacked members, so it must win where they overlap.
   *  Check self FIRST — members still catch clicks in their peek bands, where the
   *  root doesn't `intersect` so we fall through to the hosts (whose `StackHost`
   *  hit-test already orders members front-to-back by `zIndex`). Without this,
   *  clicking dust's body resolves to the axe stacked behind it. */
  override hitTestLayout(parentX: number, parentY: number): LayoutNode | null {
    const localX = parentX - this.x;
    const localY = parentY - this.y;
    if (this.intersects(localX, localY)) return this;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const hit = this.children[i].hitTestLayout(localX, localY);
      if (hit) return hit;
    }
    return null;
  }

  /** Direct spec injection — the eventual wasm `@draw` output path. */
  setSpec(list: PrimList): void {
    this.spec = list;
    this.layer.setBox(cardBox(this.width, this.height));
    this.layer.draw(list);
    this.invalidate();
  }

  protected override layout(): boolean | void {
    // Position: identical tail to LayoutRectCard — target, or cursor-follow
    // while dragging — driven through the base's tween.
    let effX = this.targetX;
    let effY = this.targetY;
    if (this.state.dragging) {
      const ptr = this.ctx.input?.lastPointer;
      if (ptr) {
        effX = ptr.x - this.dragOffsetX;
        effY = ptr.y - this.dragOffsetY;
      }
    }
    const moving = this.tweenTo(effX, effY);
    const easing = this.layer.settle();
    // Death finalize: once the `@destroy` exit prims have settled, splice the
    // chain + write `dead: 2` (which tears us down). `finalizeDestroy` may
    // synchronously destroy this node, so do nothing after it.
    if (this.destroying && !easing) {
      this.finalizeDestroy();
      return false;
    }
    // Stay dirty for the WHOLE drag, not just while catching up: pointer moves
    // don't invalidate us, so once the card reaches the cursor (`moving` false)
    // the dirty loop would idle and the card would stop following until the next
    // unrelated invalidate. `dragging` keeps `layout()` running every frame so it
    // re-reads `lastPointer` continuously. (Mirrors LayoutRectCard's return.)
    return this.state.dragging || moving || easing || undefined;
  }

  /** Complete the `dead === 1` exit. Order mirrors `RectCard`: splice FIRST
   *  (needs us still in the `cards` map), THEN write `dead: 2` — that transition
   *  fires `CardManager`'s teardown, which destroys this layout node. */
  private finalizeDestroy(): void {
    this.ctx.cards?.spliceCard(this.cardId);
    const cur = this.ctx.data.cardsLocal.get(this.cardId);
    if (cur) this.ctx.data.setLocalCard(this.cardId, { ...cur, dead: 2 });
  }

  override setBounds(x: number, y: number, width: number, height: number): void {
    const sizeChanged = width !== this.width || height !== this.height;
    super.setBounds(x, y, width, height);
    if (sizeChanged && this.spec) {
      this.layer.setBox(cardBox(this.width, this.height));
      this.layer.draw(this.spec);
    }
  }

  override destroy(): void {
    this.layer.destroy();
    super.destroy();
  }

  /** Run the card's `:visuals` hook through the VM (`drawVisuals`) and reconcile.
   *  Faction is resolved and passed in the host (the DSL reads `*faction` for
   *  faction-tinted art) AND set on `deps` so `SpritePrim` picks the faction LOD
   *  during the draw. `hook` = `@init` (first draw), `@update` (data change), or
   *  `@destroy` (the dying exit — its prims are the targets we ease out to). */
  private rebuildSpec(hook: "init" | "update" | "destroy"): void {
    if (this.currentPackedDefinition === null) {
      this.spec = null;
      return;
    }
    const def = this.ctx.definitions.decode(this.currentPackedDefinition);
    const faction =
      (def ? this.ctx.definitions.cardFactionOverride(def) : null) ??
      ownerFactionFolder(this.ctx, this.cardId) ??
      undefined;
    this.deps.faction = faction;
    const host: VisualHost = {};
    if (faction) host.faction = faction;
    host.card_data = this.buildCardData();
    this.spec = drawVisuals(this.currentPackedDefinition, host, hook);
    if (hook === "destroy") {
      // Diagnostic for the roll-up: no `mask` entry → stale CONTENT (the gate
      // hasn't served the new card_death/@destroy); a `mask` with `enter:
      // undefined` → stale WASM pkg (the `enter` serializer isn't loaded).
      const mask = this.spec.find((p) => p.kind === "mask");
      debug.log(
        ["cards"],
        `[generic] card ${this.cardId} @destroy prims=${this.spec.length} mask=${mask ? `enter=${JSON.stringify(mask.enter)}` : "MISSING"}`,
        5,
      );
    }
    this.drawn = true;
    this.layer.setBox(cardBox(this.width, this.height));
    this.layer.draw(this.spec);
  }

  /** The `^card_data` record — the card's runtime state the DSL reads to drive
   *  visual states (stack position, overlays, progress) WITHOUT the engine
   *  hardcoding the geometry. A structured map (not big-int fields), so the DSL
   *  can do `*d.stack.index`, `*d.progress.0`, etc.
   *
   *  - `stack.{state,index}` — the card's place in its chain (from the row's
   *    micro). This is what lets the stack fan move into the DSL: the engine
   *    holds the root x/y; the DSL offsets prims by `index`.
   *  - `loose` — 1 when not stacked.
   *  - overlay flags (`hovered`/`selected`/`pending`/`dragging`) — snapshot at
   *    the last data apply; a re-draw on state change is a follow-up.
   *  - `progress` — the card's active bars as `{ id, style }`. `id` is the track
   *    index the engine resolves to live timing (via `deps.progress`); the DSL
   *    reads `*d.progress.<i>.id`/`.style` to author a `^progress` prim. */
  private buildCardData(): HostValue {
    const micro = this.currentRow
      ? decodeMicro(this.currentRow.microLocation, this.currentRow.flags)
      : null;
    const stacked = micro?.kind === "stacked";
    // Fan direction as a y-sign the DSL multiplies the index by: -1 up / +1 down
    // / 0 hex (centred). Mirrors `applyPosition`'s `sign` so the prim offset and
    // the hit-test offset (`stackOffsetY`) stay in lockstep.
    const dir = stacked ? directionForBranch(micro.branch) : null;
    const dirSign = dir === "top" ? -1 : dir === "bottom" ? 1 : 0;
    // Use the DERIVED 1-indexed chain step (gap-collapsed, drag-aware), the SAME
    // value `applyPosition` uses for `stackOffsetY` — so the DSL prim offset
    // (`*d.stack.index · dir · title_height`) lands exactly where the container's
    // hit-test box is shifted. Raw `micro.index` would leave the first member at
    // offset 0 (hidden) and gaps after removals.
    const step = stacked ? this.chainStep(micro.root, micro.branch, micro.index) : 0;
    return {
      stack: {
        state: stacked ? micro.branch : 0,
        index: step,
        dir: dirSign,
      },
      loose: micro?.kind === "loose" ? 1 : 0,
      hovered: this.state.hovered ? 1 : 0,
      selected: this.state.selected ? 1 : 0,
      pending: this.state.pending ? 1 : 0,
      dragging: this.state.dragging ? 1 : 0,
      // The card's progress bars as { id (= the track index the engine resolves),
      // style }. The timing stays client-side (the engine fills live via
      // `deps.progress`); the DSL reads `*d.progress.<i>.id` / `.style`.
      progress: (this.ctx.data.cardsLocal.get(this.cardId)?.progress ?? []).map((p, i) => ({
        id: i,
        style: p.style,
      })),
    };
  }

  /** Live fill (0..1) for progress-bar `target` (an index into this card's
   *  progress list), from the row's `(startSecs, endSecs)` vs the server clock.
   *  `< 0` when there's no such bar → the prim hides itself. Recomputed each
   *  frame by `ProgressPrim` so the bar fills without the DSL re-running.
   *
   *  NB `startSecs`/`endSecs` are MISNAMED — they hold validAt MILLISECONDS (see
   *  `validAtOf`), the SAME base as `serverNowMs()`. The earlier `* 1000` made
   *  `start` 1000× too large, so `now - start` was always hugely negative and the
   *  bar clamped to 0 forever (looked stuck/empty). The legacy `ProgressBarLayer`
   *  compares them unscaled too. */
  private progressFraction(target: number): number {
    const p = this.ctx.data.cardsLocal.get(this.cardId)?.progress?.[target];
    if (!p) return -1;
    const start = p.startSecs;
    const end = p.endSecs;
    if (end <= start) return 1;
    const now = this.ctx.reducers.serverNowMs();
    return Math.max(0, Math.min(1, (now - start) / (end - start)));
  }
}
