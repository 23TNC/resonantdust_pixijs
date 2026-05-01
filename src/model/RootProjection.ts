import {
  client_cards,
  macro_zone_cards,
  type CardId,
  type MacroZone,
} from "@/spacetime/Data";
import { isAnimating, isDragging, isHidden } from "@/model/CardModel";
import { type CardShape, getCardShape } from "@/definitions/CardTypes";

/**
 * Filter spec for `getRoots`.  Every constraint is independent — leaving a
 * field undefined means "don't filter on this property."
 *
 * Default behaviour (matches Inventory / World expectations):
 *   excludeStacked   = true
 *   excludeDragState = true
 *   excludeHidden    = false
 */
export interface RootFilter {
  macro_zone:        MacroZone;
  /** Optional layer pin.  When set, only cards on this layer are returned. */
  layer?:            number;
  /** When true, only `is_panel` cards.  Mutually exclusive with `worldOnly`. */
  panelOnly?:        boolean;
  /** When true, only `is_world` cards. */
  worldOnly?:        boolean;
  /** Allow-list — only include cards whose `card_type` is in this set. */
  cardTypes?:        ReadonlySet<number>;
  /** Deny-list — exclude cards whose `card_type` is in this set. */
  excludeCardTypes?: ReadonlySet<number>;
  /** Shape filter — when set, only include cards whose card_type's shape
   *  matches.  `"rect"` for cards rendered as RectCards (CardStacks),
   *  `"hex"` for HexCards. */
  shape?:            CardShape;
  /** Skip cards in any stacked state.  Default true. */
  excludeStacked?:   boolean;
  /** Skip cards being dragged or animating.  Default true. */
  excludeDragState?: boolean;
  /** Skip cards with the `hidden` local flag.  Default false. */
  excludeHidden?:    boolean;
}

/**
 * Resolve the set of root cards at a macro_zone matching the filter.
 *
 * Roots are cards whose `stack_state` is LOOSE or ATTACHED — i.e. they sit at
 * a position in their own right (panel pixel coords or hex anchor) rather
 * than mirroring a parent rect.  Stacked-up / stacked-down cards are excluded
 * by default.
 *
 * Used by Inventory ("roots in this soul's panel of these card types") and
 * World ("roots in this zone on the world layer, excluding hex tiles").
 * Centralised so adding a new filter dimension is a one-line change here.
 */
export function getRoots(filter: RootFilter): Set<CardId> {
  const roots = new Set<CardId>();
  const ids   = macro_zone_cards.get(filter.macro_zone);
  if (!ids) return roots;

  const excludeStacked   = filter.excludeStacked   ?? true;
  const excludeDragState = filter.excludeDragState ?? true;
  const excludeHidden    = filter.excludeHidden    ?? false;

  for (const card_id of ids) {
    const card = client_cards[card_id];
    if (!card)                                                     continue;
    if (filter.layer !== undefined && card.layer !== filter.layer) continue;
    if (filter.panelOnly && !card.is_panel)                        continue;
    if (filter.worldOnly && !card.is_world)                        continue;
    if (filter.cardTypes && !filter.cardTypes.has(card.card_type)) continue;
    if (filter.excludeCardTypes?.has(card.card_type))              continue;
    if (filter.shape && getCardShape(card.card_type) !== filter.shape) continue;
    if (excludeStacked   && (card.stacked_up || card.stacked_down)) continue;
    if (excludeDragState && (isDragging(card_id) || isAnimating(card_id))) continue;
    if (excludeHidden    && isHidden(card_id))                     continue;
    roots.add(card_id);
  }

  return roots;
}
