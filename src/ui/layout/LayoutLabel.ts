import { Text, TextStyle } from "pixi.js";
import { LayoutObject, type LayoutObjectOptions } from "./LayoutObject";

export type LabelAlign  = "left"   | "center" | "right";
export type LabelValign = "top"    | "middle"  | "bottom";

export interface LayoutLabelOptions extends LayoutObjectOptions {
  text?:       string;
  fontSize?:   number;
  fill?:       number;
  fontFamily?: string;
  fontWeight?: string;
  align?:      LabelAlign;
  valign?:     LabelValign;
}

/**
 * A LayoutObject that renders a single text label inside its inner rect.
 * The text is never clipped — size the label so it has enough room.
 */
export class LayoutLabel extends LayoutObject {
  private readonly _text: Text;
  private _align:  LabelAlign;
  private _valign: LabelValign;

  constructor(options: LayoutLabelOptions = {}) {
    super(options);

    this._align  = options.align  ?? "center";
    this._valign = options.valign ?? "middle";

    this._text = new Text({
      text:  options.text ?? "",
      style: new TextStyle({
        fontSize:   options.fontSize   ?? 14,
        fill:       options.fill       ?? 0xffffff,
        fontFamily: options.fontFamily ?? "sans-serif",
        fontWeight: options.fontWeight ?? "normal",
      }),
    });

    this.addDisplay(this._text);
    this.invalidateRender();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  setText(text: string): void {
    if (this._text.text === text) return;
    this._text.text = text;
    this.invalidateRender();
  }

  getText(): string { return this._text.text; }

  setLabelStyle(options: Partial<Omit<LayoutLabelOptions, keyof LayoutObjectOptions>>): void {
    if (options.text       !== undefined) this._text.text              = options.text;
    if (options.fontSize   !== undefined) this._text.style.fontSize   = options.fontSize;
    if (options.fill       !== undefined) this._text.style.fill       = options.fill;
    if (options.fontFamily !== undefined) this._text.style.fontFamily = options.fontFamily;
    if (options.fontWeight !== undefined) this._text.style.fontWeight = options.fontWeight;
    if (options.align      !== undefined) this._align  = options.align;
    if (options.valign     !== undefined) this._valign = options.valign;
    this.invalidateRender();
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  protected override redraw(): void {
    const { x, y, width, height } = this.innerRect;

    let tx: number;
    let anchorX: number;
    switch (this._align) {
      case "left":   tx = x;             anchorX = 0;   break;
      case "right":  tx = x + width;     anchorX = 1;   break;
      default:       tx = x + width / 2; anchorX = 0.5; break;
    }

    let ty: number;
    let anchorY: number;
    switch (this._valign) {
      case "top":    ty = y;              anchorY = 0;   break;
      case "bottom": ty = y + height;     anchorY = 1;   break;
      default:       ty = y + height / 2; anchorY = 0.5; break;
    }

    this._text.anchor.set(anchorX, anchorY);
    this._text.position.set(tx, ty);
  }
}
