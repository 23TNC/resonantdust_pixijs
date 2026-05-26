/**
 * Reusable "cycling select" component: a row with a previous-arrow,
 * a centered label showing the current option, and a next-arrow.
 * The arrows hide at the ends of the list (via `visibility: hidden`
 * so the label stays centered) — there's no wrap-around. Generic in
 * the option type so callers get type-safe values back via the
 * `onChange` callback.
 *
 * Layout strategy: flex row, label is `flex: 1 1 auto` so it
 * absorbs the slack while the arrows hold their natural size on
 * either side. Using `visibility: hidden` rather than
 * `display: none` for boundary hiding keeps the label perfectly
 * centered across the whole row instead of shifting toward
 * whichever arrow is visible.
 */

const ROW_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
};

const LABEL_CSS: Partial<CSSStyleDeclaration> = {
  flex: "1 1 auto",
  textAlign: "center",
  fontFamily: "sans-serif",
  fontSize: "13px",
  color: "#ecd6aa",
};

const ARROW_BTN_CSS: Partial<CSSStyleDeclaration> = {
  background: "none",
  border: "1px solid #3a3a4a",
  borderRadius: "3px",
  color: "#ecd6aa",
  cursor: "pointer",
  fontSize: "11px",
  padding: "2px 6px",
  lineHeight: "1",
  minWidth: "24px",
};

export interface CyclingSelectOption<T> {
  /** The value emitted via `onChange` / returned by `getValue()`
   *  when this option is selected. Compared by reference / value
   *  equality with `===`. */
  value: T;
  /** Label rendered in the centre of the row when this option is
   *  current. */
  label: string;
}

export interface CyclingSelectOptions<T> {
  options: readonly CyclingSelectOption<T>[];
  /** Initial value. Defaults to the first option. Falls back to
   *  the first option if the supplied value isn't in the list. */
  initial?: T;
  /** Fired every time the user navigates to a different option.
   *  Not fired on the initial render. */
  onChange?: (value: T) => void;
  /** Optional minimum width for the centered label, in any CSS
   *  length value. Use when the option labels vary in width and
   *  you want the control's overall size to stay stable — set to
   *  fit the longest expected label. */
  labelMinWidth?: string;
}

export class CyclingSelect<T> {
  /** Root DOM element. Caller is responsible for parenting it. */
  readonly element: HTMLDivElement;
  private readonly options: readonly CyclingSelectOption<T>[];
  private readonly onChange: ((value: T) => void) | null;
  private readonly labelEl: HTMLSpanElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private index = 0;

  constructor(opts: CyclingSelectOptions<T>) {
    if (opts.options.length === 0) {
      throw new Error("CyclingSelect needs at least one option");
    }
    this.options = opts.options;
    this.onChange = opts.onChange ?? null;
    if (opts.initial !== undefined) {
      const i = this.options.findIndex((o) => o.value === opts.initial);
      if (i !== -1) this.index = i;
    }

    this.element = document.createElement("div");
    Object.assign(this.element.style, ROW_CSS);

    this.prevBtn = document.createElement("button");
    Object.assign(this.prevBtn.style, ARROW_BTN_CSS);
    this.prevBtn.textContent = "◀";
    this.prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.go(-1);
    });
    this.element.appendChild(this.prevBtn);

    this.labelEl = document.createElement("span");
    Object.assign(this.labelEl.style, LABEL_CSS);
    if (opts.labelMinWidth) this.labelEl.style.minWidth = opts.labelMinWidth;
    this.element.appendChild(this.labelEl);

    this.nextBtn = document.createElement("button");
    Object.assign(this.nextBtn.style, ARROW_BTN_CSS);
    this.nextBtn.textContent = "▶";
    this.nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.go(1);
    });
    this.element.appendChild(this.nextBtn);

    this.render();
  }

  /** Set the current value programmatically. Does NOT fire
   *  `onChange` — that's reserved for user-driven navigation,
   *  matching standard form-element conventions. */
  setValue(value: T): void {
    const i = this.options.findIndex((o) => o.value === value);
    if (i === -1) return;
    this.index = i;
    this.render();
  }

  getValue(): T {
    return this.options[this.index].value;
  }

  private go(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.options.length) return;
    this.index = next;
    this.render();
    this.onChange?.(this.getValue());
  }

  private render(): void {
    this.labelEl.textContent = this.options[this.index].label;
    this.prevBtn.style.visibility = this.index === 0 ? "hidden" : "";
    this.nextBtn.style.visibility = this.index === this.options.length - 1 ? "hidden" : "";
  }
}
