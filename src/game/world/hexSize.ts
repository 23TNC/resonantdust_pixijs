/** Size at which world hex tiles (and hex cards placed on world hexes)
 *  are *displayed*. Independent from the texture-bake size
 *  (`HEX_TEXTURE_RADIUS`) and the inventory display size
 *  (`INVENTORY_HEX_RADIUS`); LayoutWorld sets `sprite.setSize(...)`
 *  on each tile sprite so the baked texture scales to this size. */
export const WORLD_HEX_RADIUS = 96;
export const WORLD_HEX_WIDTH  = Math.sqrt(3) * WORLD_HEX_RADIUS;
export const WORLD_HEX_HEIGHT = WORLD_HEX_RADIUS * 2;
