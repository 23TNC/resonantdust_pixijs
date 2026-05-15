import { debug } from "../../debug";
import type { GameContext } from "../../GameContext";
import type { StarterPack } from "../../game/definitions/DefinitionManager";
import { CharacterSelectLayout } from "./CharacterSelectLayout";
import { GameScene } from "../game/GameScene";
import { Scene } from "../Scene";

/**
 * Post-login landing scene. Shows the player their owned cards in
 * the right panel and reserves space on the left for a future
 * character chooser. Title bar matches the game scene so the frame
 * feels continuous.
 *
 * Read-only over server data: the right-panel `OwnedCardsPanel`
 * walks `cardsLocal` filtered by `owner_id == playerId` and renders
 * each card flat, **ignoring `macroZone` / `microZone` /
 * `microLocation` / `surface`**. No card rows are rewritten, no
 * reducers fire — the server's view of every card stays exactly
 * the same regardless of what this scene displays.
 *
 * Under the post-flag-20 card-owner model, `owner_id == playerId`
 * matches exactly the player's **soul cards** (those carrying
 * `FLAG_OWNED_BY_PLAYER`). That's the desired set for character
 * select — each soul is a separately-playable avatar, and the
 * "Play" button hands one of them to `set_soul` / the in-game
 * subscription as the active soul.
 *
 * Distinct from `GameScene`'s setup:
 * - No `LayoutManager` / per-zone surface registration; cards
 *   aren't routed through the chain / drag / splice machinery.
 * - No `CardManager` — the panel reads `cardsLocal` directly and
 *   builds its own `RectCardVisual` / `HexCardVisual` per card.
 * - `subscribeOwnedCards(playerId)` instead of the per-zone
 *   inventory subscription used by the game scene.
 */
export class CharacterSelectScene extends Scene {
  private layout!: CharacterSelectLayout;
  private playerId = 0;
  private ctxRef: GameContext | null = null;
  /** Soul card id we're currently subscribed to for the
   *  left-panel inventory display. Swapped on selection change so
   *  the displayed soul's owned cards actually arrive in
   *  `cardsLocal`. `null` when nothing's selected. */
  private subscribedSoulId: number | null = null;
  /** Unsub for the `subscribeLocalCard` watcher installed by
   *  `handleCreateCharacter` before it fires the reducer. Cleaned
   *  up on `onExit` if the soul row never arrived (e.g. reducer
   *  errored before we got the callback). */
  private pendingCreateUnsub: (() => void) | null = null;

  onEnter(ctx: GameContext): void {
    const player = ctx.playerSession.getPlayer();
    if (!player) {
      throw new Error("CharacterSelectScene entered without a logged-in player");
    }

    this.ctxRef = ctx;
    this.playerId = player.playerId;
    this.layout = new CharacterSelectLayout(
      ctx,
      player.name,
      player.playerId,
      (cardId) => this.handlePlay(ctx, cardId),
      (pack) => this.handleCreateCharacter(ctx, pack),
      (soulId) => this.handleSelectedSoulChange(ctx, soulId),
    );
    this.root.addChild(this.layout.container);

    void ctx.data.subscriptions.subscribeOwnedCards(player.playerId);
  }

  onExit(): void {
    this.pendingCreateUnsub?.();
    this.pendingCreateUnsub = null;

    if (this.ctxRef) {
      this.ctxRef.data.subscriptions.unsubscribeOwnedCards(this.playerId);
      if (this.subscribedSoulId !== null) {
        this.ctxRef.data.subscriptions.unsubscribeOwnedCards(this.subscribedSoulId);
        this.subscribedSoulId = null;
      }
      this.ctxRef = null;
    }

    this.layout.destroy();
  }

  onResize(width: number, height: number): void {
    this.layout.setBounds(0, 0, width, height);
    this.layout.layoutIfDirty();
  }

  update(deltaMS: number): void {
    // Title bar's FPS / draw-call readout — same wiring GameScene
    // uses. `drawCallCounter` is patched onto the Pixi renderer in
    // `main.ts`; `readAndReset()` returns the count since the last
    // call and zeroes the accumulator. Skipping this here would
    // leave the chip blank in character select even though the
    // counter is happily incrementing.
    const drawCalls = this.ctxRef?.drawCallCounter.readAndReset() ?? 0;
    this.layout.titleBar.updateStats(deltaMS, drawCalls);
    this.layout.layoutIfDirty();
  }

  /** Play-button callback. Sets `SoulManager.activeSoul` to the
   *  user-picked card and transitions to `GameScene`. The choice
   *  lives entirely in client state — there's no server-side
   *  "currently-active soul" persistence; every reducer the player
   *  invokes takes an explicit `soul_card_id` (or derives one from
   *  a card they're acting on). */
  private handlePlay(ctx: GameContext, cardId: number): void {
    ctx.souls.setActiveSoul(cardId);
    ctx.scenes.change(new GameScene()).catch((err) => {
      console.error("[CharacterSelectScene] scene change failed", err);
    });
  }

  /** Create-character callback from the starter-packs panel.
   *
   *  Fires `createCharacter` and watches for the new soul card to
   *  arrive in `cardsLocal`, then automatically transitions to
   *  `GameScene` as that character. The watcher is installed BEFORE
   *  the reducer call so there's no window where the soul row could
   *  arrive and be missed. */
  private handleCreateCharacter(ctx: GameContext, pack: StarterPack): void {
    const FLAG_OWNED_BY_PLAYER = 1 << 20;

    // Snapshot existing soul card IDs so we can identify the new one.
    const priorSoulIds = new Set<number>();
    for (const card of ctx.data.cardsLocal.values()) {
      if (card.ownerId === this.playerId && (card.flags & FLAG_OWNED_BY_PLAYER) !== 0) {
        priorSoulIds.add(card.cardId);
      }
    }

    let transitioned = false;
    let unsubNewSoul: (() => void) | null = null;
    unsubNewSoul = ctx.data.subscribeLocalCard((change) => {
      if (transitioned || change.kind !== "added") return;
      const card = change.row;
      if (card.ownerId !== this.playerId) return;
      if ((card.flags & FLAG_OWNED_BY_PLAYER) === 0) return;
      if (priorSoulIds.has(card.cardId)) return;
      transitioned = true;
      unsubNewSoul?.();
      unsubNewSoul = null;
      this.pendingCreateUnsub = null;
      ctx.souls.setActiveSoul(card.cardId);
      ctx.scenes.change(new GameScene()).catch((err) => {
        debug.log(["spacetime"], `[CharacterSelectScene] scene change after create failed: ${err}`, 1);
      });
    });
    this.pendingCreateUnsub = unsubNewSoul;

    debug.log(
      ["spacetime"],
      `[CharacterSelectScene] create character: pack id=${pack.id} soul=${pack.soul} packId=${pack.packId} contents=[${pack.contents.map((c) => `${c.cardKey}×${c.count}`).join(", ")}]`,
      2,
    );

    void ctx.reducers.createCharacter({ starterPackId: pack.id })
      .catch((err) => {
        if (!transitioned) {
          unsubNewSoul?.();
          unsubNewSoul = null;
          this.pendingCreateUnsub = null;
        }
        debug.log(["spacetime"], `[CharacterSelectScene] createCharacter reducer failed: ${err}`, 1);
      });
  }

  /** Selection-change callback from the right panel. When the
   *  player picks a different soul (or deselects), swap the
   *  per-soul inventory subscription:
   *
   *  - Unsubscribe the previously-selected soul's owner-cards so
   *    we don't keep streaming rows the UI is no longer showing.
   *  - Subscribe to the newly-selected soul's owner-cards so its
   *    inventory rows arrive in `cardsLocal` for the
   *    `SoulInventoryPanel` to read.
   *
   *  This is per-soul scope, on top of the panel-level
   *  `subscribeOwnedCards(playerId)` that brings in the souls
   *  themselves. SDK dedupes overlapping subscriptions; the cost
   *  of subscribing/unsubscribing on each click is a single round
   *  trip plus the rows for that soul. */
  private handleSelectedSoulChange(ctx: GameContext, soulId: number | null): void {
    if (this.subscribedSoulId === soulId) return;
    if (this.subscribedSoulId !== null) {
      ctx.data.subscriptions.unsubscribeOwnedCards(this.subscribedSoulId);
    }
    this.subscribedSoulId = soulId;
    if (soulId !== null) {
      void ctx.data.subscriptions.subscribeOwnedCards(soulId);
    }
  }
}
