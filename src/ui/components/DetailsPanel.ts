import { type Ticker } from "pixi.js";
import { getApp } from "@/app";
import {
  client_cards,
  selected_card_id,
  CARD_TYPE_DISCIPLINE,
  CARD_TYPE_FACULTY,
  CARD_TYPE_REQUISITES,
  CARD_TYPE_REVERY,
  CARD_TYPE_SOUL,
  CARD_TYPE_FLOOR,
  CARD_TYPE_TILE_OBJECT,
  CARD_TYPE_TILE_DECORATOR,
  type ClientCard,
} from "@/spacetime/Data";
import {
  getDefinitionByPacked,
  type CardDefinition,
} from "@/definitions/CardDefinitions";
import { LayoutLabel, type LayoutLabelOptions } from "@/ui/layout/LayoutLabel";

export interface DetailsPanelOptions extends LayoutLabelOptions {
  /** Ticks between text refreshes. Default: 10 (~6×/s at 60 fps). */
  updateInterval?: number;
}

/**
 * Multi-line label that describes the currently selected card
 * (Data.selected_card_id).  The body is formatted per card_type so each
 * domain shows the fields that matter for it; an empty selection or
 * unknown card_id renders a placeholder.
 *
 * Refreshes itself on a ticker — no external sync calls required.
 */
export class DetailsPanel extends LayoutLabel {
  private readonly _updateInterval: number;
  private _frameCount = 0;
  private _lastRendered = "";

  constructor(options: DetailsPanelOptions = {}) {
    super({ align: "left", valign: "top", ...options });
    this._updateInterval = options.updateInterval ?? 10;
    this._refresh();
    getApp().ticker.add(this._onTick, this);
  }

  override destroy(options?: Parameters<InstanceType<typeof LayoutLabel>["destroy"]>[0]): void {
    getApp().ticker.remove(this._onTick, this);
    super.destroy(options);
  }

  // ─── Ticker ──────────────────────────────────────────────────────────────

  private _onTick(_ticker: Ticker): void {
    if (++this._frameCount < this._updateInterval) return;
    this._frameCount = 0;
    this._refresh();
  }

  private _refresh(): void {
    let next: string;
    if (selected_card_id === 0) {
      next = "(no selection)";
    } else {
      const card = client_cards[selected_card_id];
      if (!card) {
        next = `(card #${selected_card_id} not found)`;
      } else {
        const def   = getDefinitionByPacked(card.packed_definition);
        const lines = this._formatCard(card, def);
        next = lines.join("\n");
      }
    }
    if (next !== this._lastRendered) {
      this._lastRendered = next;
      this.setText(next);
    }
  }

  // ─── Formatters ──────────────────────────────────────────────────────────

  private _formatCard(card: ClientCard, def: CardDefinition | undefined): string[] {
    switch (card.card_type) {
      case CARD_TYPE_SOUL: return this._formatSoul(card, def);
      case CARD_TYPE_FLOOR:
      case CARD_TYPE_TILE_OBJECT:
      case CARD_TYPE_TILE_DECORATOR:
        return this._formatTile(card, def);
      case CARD_TYPE_DISCIPLINE:
      case CARD_TYPE_FACULTY:
      case CARD_TYPE_REQUISITES:
      case CARD_TYPE_REVERY:
        return this._formatGeneric(card, def);
      default:
        return this._formatGeneric(card, def);
    }
  }

  private _formatGeneric(card: ClientCard, def: CardDefinition | undefined): string[] {
    return [
      ...this._header(card, def),
      ...this._location(card),
      ...this._stackingInfo(card),
      ...this._vars(def),
      ...this._flags(def),
    ];
  }

  private _formatSoul(card: ClientCard, def: CardDefinition | undefined): string[] {
    return [
      ...this._header(card, def),
      `World: q=${card.world_q}  r=${card.world_r}  z=${card.layer}`,
      ...this._vars(def, ["vision", "influence"]),
      ...this._flags(def),
    ];
  }

  private _formatTile(card: ClientCard, def: CardDefinition | undefined): string[] {
    return [
      ...this._header(card, def),
      `Hex:   q=${card.local_q}  r=${card.local_r}`,
      `World: q=${card.world_q}  r=${card.world_r}  z=${card.layer}`,
      ...this._vars(def),
      ...this._flags(def),
    ];
  }

  // ─── Section helpers ─────────────────────────────────────────────────────

  private _header(card: ClientCard, def: CardDefinition | undefined): string[] {
    const name = def?.display_name ?? `card #${card.card_id}`;
    return [
      name,
      `${this._typeLabel(card.card_type)} #${card.card_id}`,
      "",
    ];
  }

  private _location(card: ClientCard): string[] {
    if (card.is_world) {
      return [`World: q=${card.world_q}  r=${card.world_r}  layer=${card.layer}`];
    }
    if (card.is_panel) {
      return [`Panel: x=${card.pixel_x}  y=${card.pixel_y}  layer=${card.layer}  soul=#${card.panel_card_id}`];
    }
    return [];
  }

  private _stackingInfo(card: ClientCard): string[] {
    if (card.stacked_up)        return [`Stacked up on #${card.stacked_on_id}`];
    if (card.stacked_down)      return [`Stacked down on #${card.stacked_on_id}`];
    if (card.attached_to_floor) return [`Attached to floor at hex (${card.local_q}, ${card.local_r})`];
    if (card.attached)          return [`Attached to hex card #${card.attached_to_id}`];
    return [];
  }

  private _vars(def: CardDefinition | undefined, only?: string[]): string[] {
    if (!def?.vars) return [];
    const entries = Object.entries(def.vars).filter(
      ([key]) => !only || only.includes(key),
    );
    if (entries.length === 0) return [];
    const lines = ["", "Vars:"];
    for (const [key, value] of entries) lines.push(`  ${key}: ${value}`);
    return lines;
  }

  private _flags(def: CardDefinition | undefined): string[] {
    if (!def?.flags || def.flags.length === 0) return [];
    const lines = ["", "Flags:"];
    for (const [name, a, b, c] of def.flags) {
      lines.push(`  ${name}: ${a ? "A" : "·"}${b ? "B" : "·"}${c ? "C" : "·"}`);
    }
    return lines;
  }

  private _typeLabel(t: number): string {
    switch (t) {
      case CARD_TYPE_DISCIPLINE:     return "Discipline";
      case CARD_TYPE_FACULTY:        return "Faculty";
      case CARD_TYPE_REQUISITES:     return "Requisites";
      case CARD_TYPE_REVERY:         return "Revery";
      case CARD_TYPE_SOUL:           return "Soul";
      case CARD_TYPE_FLOOR:          return "Floor";
      case CARD_TYPE_TILE_OBJECT:    return "Tile Object";
      case CARD_TYPE_TILE_DECORATOR: return "Tile Decorator";
      default:                       return `Type ${t}`;
    }
  }
}
