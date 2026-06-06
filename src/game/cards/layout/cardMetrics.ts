// Canonical card pixel footprint — the card cell size used by the inventory
// grid and the rect tile bake. The DSL also exposes these as the `card_width` /
// `card_height` globals; these TS constants stay until those consumers can read
// globals at module-eval time (the grid derives its cell size at import).

export const CARD_WIDTH  = 72;
export const CARD_HEIGHT = 96;
