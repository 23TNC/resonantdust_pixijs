/**
 * Client-side reader for `Player.flags` bit fields. Mirrors the
 * constants on the server in
 * `spacetime/server/modules/shard/src/players.rs` —
 * `PLAYER_FLAG_FACTION_SHIFT` / `PLAYER_FLAG_FACTION_MASK`. Kept as
 * inline constants instead of a content-side catalog because there's
 * only one field today; promote to a JSON catalog (`content/players/
 * flags.json` mirroring `content/cards/flags.json`) once a second
 * field lands.
 */
import type { GameContext } from "../../GameContext";
import type { Player } from "../spacetime/bindings/players/types";
import type { LocalCard } from "../data/DataManager";

/** Bit offset of the `faction` subfield inside `Player.flags`. */
const PLAYER_FLAG_FACTION_SHIFT = 0;
/** Mask of the `faction` subfield (u2, 4 values). */
const PLAYER_FLAG_FACTION_MASK = 0b11;

/** Folder name (under `pixijs/public/textures/cards/objects/<size>_<aspect>/`)
 *  matching each faction value, used by `LodTextureManager.get`'s
 *  faction-aware lookup. Index = faction value `0..=3`. `null` means
 *  "no faction folder lookup" — `LodTextureManager.get` skips the
 *  faction-aware path entirely and falls straight through to the
 *  bare-files-at-root layout.
 *
 *  Packs may opt into an explicit `neutral/` subfolder (preferred for
 *  new art so every faction is a sibling and no bare files sit at the
 *  root) OR keep neutral as bare files at the aspect-folder root
 *  (legacy `256_human/1.png` shape). Both work: the explicit subfolder
 *  is picked up by the faction-aware path when we ask for `"neutral"`;
 *  the bare-files-at-root layout is picked up by the empty-pack
 *  fallback recursion in `LodTextureManager.get`. */
const FACTION_FOLDERS: ReadonlyArray<string | null> = [
  "neutral",   // 0 — neutral / default
  "chorus",    // 1 — chorus (FactionChorus in recipes/aliases.json)
  "chord",     // 2 — chord  (FactionChord)
  "resonance", // 3 — resonance (FactionResonance)
];

/** Extract the faction subfield from a player's `flags`. Returns
 *  `0..=3`. Mirrors the server's `player_faction(player)` helper. */
export function playerFaction(player: Player): number {
  return (player.flags >>> PLAYER_FLAG_FACTION_SHIFT) & PLAYER_FLAG_FACTION_MASK;
}

/** Map a faction value to the matching folder name, or `null` for
 *  the neutral fallback. The resolver treats `null` as "skip the
 *  faction-aware lookup path entirely and go straight to the
 *  legacy `<size>_<aspect>_pack/`." */
export function factionFolder(faction: number): string | null {
  return FACTION_FOLDERS[faction] ?? null;
}

/** Faction folder for the local player (the one this client is signed
 *  in as). Returns `null` if pre-login or the local Player row isn't
 *  hydrated yet. Used by drag previews and other "I'm rendering my
 *  own card" surfaces that have no owner chain to walk. */
export function localPlayerFactionFolder(ctx: GameContext): string | null {
  const id = ctx.zones?.getPlayerId() ?? null;
  if (id === null) return null;
  const player = ctx.data.playersLocal.get(id);
  if (!player) return null;
  return factionFolder(playerFaction(player));
}

/** Walk a card's owner chain to find the owning player's faction
 *  folder. Returns `null` (= neutral) when the owner chain doesn't
 *  reach a player (open-world tile, orphan card, unknown player).
 *
 *  Walk: card.owner_id might be another card_id (e.g. a player's
 *  inventory item is owned by their soul, whose owner_id is the
 *  player_id) or directly a player_id (cards owned by the player
 *  with `FLAG_OWNED_BY_PLAYER`). Walk up to 4 steps to avoid
 *  pathological cycles, looking for the chain step where
 *  `playersLocal.get(id)` resolves — that's the player. */
export function ownerFactionFolder(ctx: GameContext, cardId: number): string | null {
  const cards = ctx.data.cardsLocal;
  const players = ctx.data.playersLocal;
  let current: number | undefined = cardId;
  for (let i = 0; i < 4; i++) {
    if (current === undefined || current === 0) return null;
    const player = players.get(current);
    if (player) return factionFolder(playerFaction(player));
    const card: LocalCard | undefined = cards.get(current);
    if (!card) return null;
    current = card.ownerId;
  }
  return null;
}
