import { PanelTaskbar } from "./PanelTaskbar";
import type { UiEditMode } from "./UiEditMode";
import {
  ACTION_BTN_CSS,
  ACTIONS_CSS,
  BODY_CSS,
  edgeXCssFor,
  edgeYCssFor,
  FOOTER_BG,
  PANEL_CSS,
  RESIZE_CORNER_CSS,
  RESIZE_EDGE_X_CSS,
  RESIZE_EDGE_Y_CSS,
  resizeCornerCssFor,
  TAB_BTN_ACTIVE_CSS,
  TAB_BTN_CSS,
  TABS_CSS,
  TITLE_CSS,
  TITLEBAR_CSS,
} from "./DomPanelStyles";
import { attachDrag, attachResize, type SnapGrid } from "./pointerInteractions";

const HOST_ID = "app";

/** Per-panel category for DOM z-index banding. Panels in lower
 *  bands ("gameview") can never visually cover panels in higher
 *  bands ("inventory", "overlay", "dom"), regardless of which
 *  panel was focused last. Inside a band the usual
 *  most-recently-focused-on-top rule applies. The mapping
 *  mirrors the Pixi-side layer order in `MainLayout` —
 *  PixiPanels derive their band from their parent layer
 *  (see `PixiPanel`); pure DomPanels default to `"dom"`. */
export type DomZBand = "gameview" | "inventory" | "overlay" | "dom";

/** Lowest z-index inside each band. Each band reserves
 *  `Z_BAND_SIZE` z-indices above its base — pick a stride
 *  large enough that ordinary focus traffic can't bleed one
 *  band into the next (10k = ~10k focus bumps before wrap;
 *  realistic sessions hit dozens). */
const Z_BAND_BASE: Record<DomZBand, number> = {
  gameview:  10000,
  inventory: 20000,
  overlay:   30000,
  dom:       40000,
};
const Z_BAND_SIZE = 10000;

/** Next z-index to assign per band on focus. Module-level so
 *  every panel in the same band shares one counter and the
 *  most-recently-focused naturally sits on top within its band.
 *  Each entry seeds at its band's base; `bringToFront`
 *  increments before assigning. */
const nextZByBand: Record<DomZBand, number> = {
  gameview:  Z_BAND_BASE.gameview,
  inventory: Z_BAND_BASE.inventory,
  overlay:   Z_BAND_BASE.overlay,
  dom:       Z_BAND_BASE.dom,
};

/** Module-level registry of every live `DomPanel` instance. Used by
 *  `DomPanel.resetAllToDefaults()` so a global "I lost a panel
 *  somewhere" recovery affordance (in the settings menu) can sweep
 *  every panel back to its constructor defaults at once. Maintained
 *  through the constructor / `destroy` pair. */
const allPanels = new Set<DomPanel>();

// ── Public API ─────────────────────────────────────────────────────

/** Per-panel anchor preset. Picks which corner of the panel stays
 *  put during a resize — the *opposite* corner gets the grab handle.
 *  Anchor is independent of position (snap moves the panel; anchor
 *  only affects resize behaviour) and never gates dragging. */
export type AnchorMode =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

const VALID_ANCHORS = new Set<AnchorMode>([
  "top-left", "top-right", "bottom-left", "bottom-right",
]);

/** Coerce a persisted-string value into an `AnchorMode`, falling
 *  back to `"top-left"` for missing / malformed input. Migrates the
 *  legacy `"none"` value (pre-snap rework) to `"top-left"` so users
 *  with an old anchor land on the new default rather than crashing
 *  on an invalid enum. */
function readAnchor(raw: string | null): AnchorMode {
  return raw && VALID_ANCHORS.has(raw as AnchorMode) ? (raw as AnchorMode) : "top-left";
}

/** Extract only the CSS-rect fields from a `PanelStateJSON`. Used
 *  by the constructor to compose the effective `defaultRect`
 *  (constructor opts ← content-defaults rect ← localStorage). The
 *  remaining `PanelStateJSON` fields are non-positional and applied
 *  separately in the field-init block. */
function pickRectFields(state: PanelStateJSON): DomPanelRect {
  const out: DomPanelRect = {};
  if (state.left   !== undefined) out.left   = state.left;
  if (state.top    !== undefined) out.top    = state.top;
  if (state.right  !== undefined) out.right  = state.right;
  if (state.bottom !== undefined) out.bottom = state.bottom;
  if (state.width  !== undefined) out.width  = state.width;
  if (state.height !== undefined) out.height = state.height;
  return out;
}

/** Per-panel snap preset. `"none"` leaves position to the user (via
 *  drag / persisted rect). The four corners snap the panel to that
 *  corner of the safe area between the taskbar reserves and disable
 *  dragging while active. Snap is reapplied on window resize, panel
 *  resize end, and on open so the panel stays glued to its corner. */
export type SnapMode =
  | "none"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

const VALID_SNAPS = new Set<SnapMode>([
  "none", "top-left", "top-right", "bottom-left", "bottom-right",
]);

function readSnap(raw: string | null): SnapMode {
  return raw && VALID_SNAPS.has(raw as SnapMode) ? (raw as SnapMode) : "none";
}

/** Per-panel "what to append after the base title" preset.
 *  `"none"` shows just the constructor-time title; the other
 *  values pick a resolver registered by the panel (e.g.
 *  `"player"` → current player name, `"soul"` → current soul
 *  name) and render the title as `"<base> - <resolved>"`. A
 *  panel can omit a resolver for any mode it doesn't support
 *  — see `availableTitleSuffixes`; the popup hides the row
 *  entirely when no resolvers are registered. */
export type TitleSuffix = "none" | "player" | "soul";

const VALID_TITLE_SUFFIXES = new Set<TitleSuffix>([
  "none", "player", "soul",
]);

function readTitleSuffix(raw: string | null): TitleSuffix | null {
  return raw && VALID_TITLE_SUFFIXES.has(raw as TitleSuffix)
    ? (raw as TitleSuffix)
    : null;
}

/** Resolver function for a `TitleSuffix` mode. Returns the
 *  string to append after `" - "`, or `null` to suppress the
 *  suffix entirely (e.g. when the dependent context isn't yet
 *  loaded). Called every time the title is recomposed — keep
 *  resolvers cheap, they're not memoised. */
export type TitleSuffixResolver = () => string | null;

/** Per-panel "attach to a taskbar" preset. `"none"` leaves the
 *  panel detached (no taskbar entry — the user can only minimize
 *  in-place). The six corner / center values pick which taskbar
 *  (top / bottom edge) and which group within that bar (left /
 *  center / right) the panel's entry sits in. Driven from the
 *  Pin row in the settings popup; persisted so the choice
 *  survives reloads. */
export type PinMode =
  | "none"
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

const VALID_PINS = new Set<PinMode>([
  "none",
  "top-left",    "top-center",    "top-right",
  "bottom-left", "bottom-center", "bottom-right",
]);

function readPin(raw: string | null): PinMode | null {
  return raw && VALID_PINS.has(raw as PinMode) ? (raw as PinMode) : null;
}

/** Split a `PinMode` into the taskbar edge (`"top"` / `"bottom"`)
 *  it targets, or `null` for `"none"`. */
function pinPosition(pin: PinMode): "top" | "bottom" | null {
  if (pin.startsWith("top"))    return "top";
  if (pin.startsWith("bottom")) return "bottom";
  return null;
}

/** Taskbar side a `PinMode` routes its entry into. `"none"`
 *  returns `"left"` as a harmless default — when no taskbar is
 *  involved, side is irrelevant. */
export type PinSide = "left" | "center" | "right";

function pinSide(pin: PinMode): PinSide {
  if (pin.endsWith("right"))  return "right";
  if (pin.endsWith("center")) return "center";
  return "left";
}

/** Per-panel height-lock preset.
 *  - `"off"`: user owns the height (resize handle works freely).
 *  - `"full"` / `"half"` / `"quarter"`: lock height to that fraction
 *    of the safe area between top + bottom taskbar reserves.
 *  - `"auto"`: lock height to the content's reported natural height
 *    (set via `setContentNaturalHeight`). Used for panels whose
 *    body wraps a layout that grows / shrinks with state — the
 *    details panel toggling between compact and expanded, etc. */
export type HeightMode = "off" | "full" | "half" | "quarter" | "auto";

const VALID_HEIGHTS = new Set<HeightMode>(["off", "full", "half", "quarter", "auto"]);

function readHeight(raw: string | null, fallback: HeightMode): HeightMode {
  return raw && VALID_HEIGHTS.has(raw as HeightMode) ? (raw as HeightMode) : fallback;
}

/** Fraction of safe area for the safe-area-locked modes. `"off"`
 *  and `"auto"` aren't in here — they take separate code paths in
 *  `applyHeight`. */
const HEIGHT_FRACTIONS: Record<"full" | "half" | "quarter", number> = {
  full:    1,
  half:    1 / 2,
  quarter: 1 / 4,
};

/** Initial CSS positioning for a new panel. Mirrors the four `position:
 *  fixed` anchors plus dimensions; any subset can be supplied (the
 *  unmentioned ones are left as the browser default). Persisted
 *  `left` / `top` / `width` / `height` override these on restore. */
export interface DomPanelRect {
  left?:   string;
  top?:    string;
  right?:  string;
  bottom?: string;
  width?:  string;
  height?: string;
}

export interface DomPanelOptions {
  /** Label shown in the title bar. */
  title: string;
  /** localStorage prefix. When provided, position / size / active tab /
   *  minimized state persist under this key (`<key>.left`, etc.).
   *  Omit to opt out of persistence. */
  storageKey?: string;
  /** Stable key used to look up content-shipped defaults in the
   *  [`DomPanel.panelDefaults`] registry (seeded once at boot from
   *  `content/panels/defaults.json`). Defaults to `storageKey`.
   *  Set this explicitly on panels whose `storageKey` carries a
   *  per-instance suffix (e.g. `gameInventoryPanel:1:42`) so all
   *  instances of the same kind share one defaults entry
   *  (`gameInventoryPanel`). Precedence on new-panel init:
   *  `localStorage[storageKey]` > `panelDefaults[defaultsKey]` >
   *  constructor opts. */
  defaultsKey?: string;
  /** Initial CSS rect. Defaults to right-anchored under the titlebar. */
  defaultRect?: DomPanelRect;
  /** Minimum size when resized via the corner handle. */
  minWidth?:  number;
  minHeight?: number;
  /** Show / hide the action buttons. All default true. */
  minimizable?: boolean;
  closable?:    boolean;
  resizable?:   boolean;
  /** Render the title bar. Default `true`. Set `false` for modal /
   *  borderless surfaces (login form, fullscreen overlays) where
   *  there's no need for a drag handle or title. With the title
   *  bar gone the panel can't be dragged — combine with the other
   *  capability flags as appropriate. */
  showTitleBar?: boolean;
  /** Optional taskbar to register with. **Legacy** — kept for
   *  backwards compatibility. The new way is to set `pin` (see
   *  below); when both are provided, `pin` wins. When `pin` is
   *  omitted, the constructor derives the initial pin from
   *  `taskbar.position` + `taskbarSide`. */
  taskbar?: PanelTaskbar;
  /** Initial Pin preset — "which taskbar + which side" the
   *  panel's entry attaches to (`"top-left"`, `"bottom-right"`,
   *  etc.), or `"none"` for unpinned. The user can change this at
   *  runtime via the Pin row in the settings popup; the choice
   *  persists under `<storageKey>.pin`. Replaces the older
   *  `taskbar` + `taskbarSide` pair, which still works as a
   *  fallback initial seed when `pin` is omitted. */
  pin?: PinMode;
  /** Pinned entries in the taskbar persist while the panel is
   *  closed — click the entry to re-open the panel. Unpinned
   *  entries disappear when the panel is closed. */
  pinned?: boolean;
  /** When set, the taskbar entry renders as a square holding this
   *  single unicode glyph instead of the wide text-label rectangle.
   *  Useful for compact pinned shortcuts (settings, debug HUD). */
  taskbarIcon?: string;
  /** Pluggable resolvers for the optional `" - <content>"` title
   *  suffix. Map a `TitleSuffix` mode → function returning the
   *  string to append (or `null` when the source isn't ready, e.g.
   *  soul not loaded yet). Keys absent from the map don't appear
   *  in the popup's cycler. Resolvers close over the panel's
   *  context (`GameContext`, soul id, etc.) — use this for
   *  `"player"`-name lookups, `"soul"`-name lookups, etc. */
  titleSuffixResolvers?: Partial<Record<TitleSuffix, TitleSuffixResolver>>;
  /** First-launch / fallback title suffix mode. Localstorage and
   *  content defaults override this same as any other field;
   *  defaults to `"none"` so panels that don't bind any resolver
   *  start with just the base title. Pick `"player"` (or `"soul"`)
   *  at construction when the panel's default identifying string
   *  should be the player / soul name. */
  titleSuffix?: TitleSuffix;
  /** **Legacy** — which side of the taskbar the entry attaches
   *  to. Subsumed by `pin` (which encodes side in its suffix).
   *  Only consulted when `pin` is omitted and the constructor is
   *  deriving an initial pin from the legacy `taskbar` opt. */
  taskbarSide?: "left" | "right";
  /** App-wide UI-edit-mode reference. When set, the panel adds
   *  grid-snap / lock / hide-title-bar action buttons (only
   *  visible while edit mode is enabled) and forces the title bar
   *  visible while editing regardless of the user's hide
   *  preference. Omit for panels (like the login form) that
   *  shouldn't participate in the UI-arrangement workflow. */
  uiEditMode?: UiEditMode;
  /** Initial `HeightMode` seed when no persisted value exists.
   *  Persisted values always win (so user choices in the settings
   *  popup survive reloads); this option is the "first-launch"
   *  default for panels whose natural behaviour is auto-sizing
   *  (e.g. the details panel sets `"auto"` so the host follows
   *  compact↔expanded content). Defaults to `"off"`. */
  heightMode?: HeightMode;
  /** Per-panel blacklist of `PanelSettingsPopup` rows. Default is
   *  empty — the popup shows every row. Add a key here when a
   *  setting is genuinely meaningless or harmful for this panel
   *  (e.g., the login form excludes `"minimize"` because hiding
   *  it strands the user). The popup reads `isSettingHidden(key)`
   *  for each row and skips rendering matches. Does **not** affect
   *  the panel's own chrome — toggling `minimizable: false` still
   *  starts the panel with the minimize button hidden; the
   *  exclude list only governs popup visibility. */
  excludeSettings?: readonly PanelSettingKey[];
  /** DOM z-index band — panels in lower bands can't visually
   *  cover panels in higher bands regardless of focus order
   *  ("gameview" < "inventory" < "overlay" < "dom"). Defaults
   *  to `"dom"` for pure DOM panels (settings popup, debug HUD,
   *  login form). `PixiPanel` auto-derives this from its parent
   *  Pixi layer when the caller doesn't override. */
  domZBand?: DomZBand;
}

/** Keys for `PanelSettingsPopup` rows — each corresponds to one
 *  row in the popup. Used by `DomPanelOptions.excludeSettings` to
 *  blacklist specific rows on a per-panel basis. */
export type PanelSettingKey =
  | "titleBar"
  | "gridSnap"
  | "anchor"
  | "draggable"
  | "snap"
  | "height"
  | "pin"
  | "taskbarIcon"
  | "titleSuffix"
  | "minimize"
  | "hideMinimize"
  | "resizeX"
  | "resizeY"
  | "close"
  | "hideClose"
  | "mask"
  | "layer"
  | "reset"
  | "copyJson"
  | "copyAllJson";

/**
 * Shared DOM-based floating panel. Hosts a draggable title bar with
 * optional tab buttons, minimize / close actions, and a resizable
 * body. Designed as the foundation for the debug HUD, settings
 * dropdown, chat (after migration), and any future detachable surface
 * like an inventory or world panel.
 *
 * The panel is pure DOM — its content is appended to `#app` (or
 * `document.body` as a fallback) and composited by the browser on top
 * of the Pixi canvas. Drag / resize use document-level pointer
 * listeners so the gesture survives the cursor leaving the panel.
 *
 * Tabs are added imperatively via `addTab(id, icon, content)`. The
 * content element is owned by the caller — the panel just toggles its
 * `display` based on the active tab. When no tabs are added, the
 * caller uses `setBody(el)` to install a single body element.
 *
 * Pixi-hosting panels (future use) subscribe to `onRectChange` to
 * mirror the panel's screen rect into a Pixi `Container.setBounds`
 * call. Today's consumers (debug, settings, chat) don't need this
 * hook and ignore it.
 */
/** JSON-shaped panel state for the content-defaults registry and the
 *  per-panel clipboard export. Every property is optional — missing
 *  keys fall through to the next layer (constructor opts / hardcoded
 *  defaults). String fields for position/size are raw CSS values
 *  (`"320px"`, `"auto"`, `"calc(100vh - 64px)"`); enums match the
 *  same string values used in localStorage. */
export interface PanelStateJSON {
  left?:   string;
  top?:    string;
  right?:  string;
  bottom?: string;
  width?:  string;
  height?: string;
  anchor?: AnchorMode;
  snap?:   SnapMode;
  pin?:    PinMode;
  heightMode?:     HeightMode;
  draggable?:      boolean;
  minimizable?:    boolean;
  resizableX?:     boolean;
  resizableY?:     boolean;
  closable?:       boolean;
  hideMinimizeBtn?: boolean;
  hideCloseBtn?:    boolean;
  titleBarHidden?: boolean;
  gridSnap?:       boolean;
  /** Stencil-mask the panel body's Pixi content to the body rect.
   *  `true` (default) crops overflow at the cost of ~3 draw calls
   *  per masked container; `false` is the opt-out for panels whose
   *  content is guaranteed to fit by construction. Surfaced via the
   *  popup's Mask row; only consulted by `PixiPanel`. */
  masked?:         boolean;
  minimized?:      boolean;
  /** Taskbar entry glyph override. `null` (the default) falls
   *  back to the constructor seed; non-null overrides it. Set
   *  via the popup's Taskbar Icon row. */
  taskbarIcon?:    string | null;
  /** Active title suffix mode (`"none"` / `"player"` / `"soul"`).
   *  Drives the `" - <content>"` appended to the base title. Set
   *  via the popup's Title Suffix row. */
  titleSuffix?:    TitleSuffix;
}

export class DomPanel {
  /** Content-shipped defaults registry, keyed by `defaultsKey` (or
   *  `storageKey` when `defaultsKey` isn't set). Seeded once at boot
   *  by [`setPanelDefaults`] from `content/panels/defaults.json`.
   *  New panels merge their lookup entry between their constructor
   *  opts and localStorage — see [`getDefaultedRect`] / [`getDefaultedBool`] /
   *  [`getDefaultedString`]. Reset returns to whatever's here, NOT
   *  the constructor defaults (matches the user workflow: tweak →
   *  copy → paste → reset means "back to the layout the file
   *  describes"). */
  private static panelDefaults: Record<string, PanelStateJSON> | null = null;

  /** Install the content-shipped defaults. Call once at app boot
   *  before any panel constructs. Subsequent panels look up their
   *  `defaultsKey` (or `storageKey`) in this map at constructor
   *  time. Passing `null` clears the registry.
   *
   *  Keys starting with `_` are stripped before storage so the JSON
   *  file can carry comment-style metadata (`_comment`,
   *  `_workflow`, `_example`) at the same top level as the panel
   *  entries — matches the flat shape the "Copy All JSON" button
   *  emits, no wrapper required. */
  static setPanelDefaults(defaults: Record<string, PanelStateJSON> | null): void {
    if (defaults === null) {
      DomPanel.panelDefaults = null;
      return;
    }
    const filtered: Record<string, PanelStateJSON> = {};
    for (const [k, v] of Object.entries(defaults)) {
      if (k.startsWith("_")) continue;
      filtered[k] = v;
    }
    DomPanel.panelDefaults = filtered;
  }

  /** Snapshot every live panel's current state into a single JSON
   *  object indexed by `defaultsKey ?? storageKey`. Panels without
   *  either key are skipped (nothing to address them by). Output is
   *  paste-ready into `content/panels/defaults.json`'s `panels` map.
   *  Iterates the module-level `allPanels` registry so panels
   *  created outside `PanelManager` (singletons like ChatPanel,
   *  the DebugPanel, MainLayout host panels) are still included. */
  static collectAllPanelStates(): Record<string, PanelStateJSON> {
    const out: Record<string, PanelStateJSON> = {};
    for (const p of allPanels) {
      const key = p.defaultsKey ?? p.storageKey;
      if (!key) continue;
      out[key] = p.serializeState();
    }
    return out;
  }

  readonly panel: HTMLDivElement;
  /** Title bar div. `protected` so `PixiPanel` (and any future
   *  subclass) can hide its visuals and replace them with a
   *  Pixi-rendered chrome that draws under the drag overlay,
   *  letting cards z-order above the title bar. */
  protected readonly titlebar: HTMLDivElement;
  /** Title-text span inside the title bar. Same `protected` rationale
   *  as `titlebar` — `PixiPanel` flips its `color` to transparent so
   *  the visible text is Pixi-drawn while the DOM span still
   *  reserves layout space + ensures the click hit-area covers the
   *  text. */
  protected readonly titleEl:  HTMLSpanElement;
  private readonly tabsEl:   HTMLDivElement;
  /** Container holding the minimize / close action buttons. Same
   *  `protected` rationale — `PixiPanel` hides the DOM buttons
   *  visually (transparent text) while keeping them clickable, and
   *  draws Pixi glyphs over them. */
  protected readonly actionsEl: HTMLDivElement;
  /** Body div. Protected so `PixiPanel` (and any future subclass)
   *  can adjust its CSS — particularly `pointer-events: none` so
   *  clicks pass through to the Pixi canvas beneath. */
  protected readonly body: HTMLDivElement;
  /** Footer slot — `null` until the consumer installs one via
   *  `setFooter`. Lives below the body but above the resize corner;
   *  flex: 0 0 auto so it keeps its natural height while the body
   *  takes the remaining vertical space. Used by chat for the
   *  always-visible input row. */
  private footer: HTMLElement | null = null;
  /** Resize-corner div. `protected` so `PixiPanel` can hide its
   *  CSS gradient (the grip-line backdrop) while keeping the
   *  element in place for pointer capture, then paint Pixi grip
   *  lines over it. */
  protected readonly resizeCorner: HTMLDivElement;
  /** Width-only resize handle — thin vertical strip on whichever
   *  side of the panel sits opposite the anchor (the same side
   *  as `resizeCorner`, just running its full height minus the
   *  corner footprint). Hit-target only; no visible band. */
  protected readonly resizeEdgeX: HTMLDivElement;
  /** Height-only resize handle — thin horizontal strip on the
   *  top or bottom edge, mirroring `resizeEdgeX`'s placement
   *  rules. */
  protected readonly resizeEdgeY: HTMLDivElement;

  private readonly tabs = new Map<
    string,
    { button: HTMLButtonElement; content: HTMLElement }
  >();
  private _activeTabId: string | null = null;

  /** localStorage prefix (`<storageKey>.left`, …) or `null` when
   *  the panel opted out of persistence. Public-readonly so the
   *  settings popup and `collectAllPanelStates` can address the
   *  panel by id. */
  readonly storageKey: string | null;
  /** Stable lookup key for the content-defaults registry. Falls
   *  back to `storageKey` when unset. See [`DomPanel.panelDefaults`]. */
  readonly defaultsKey: string | null;
  private readonly minWidth:   number;
  private readonly minHeight:  number;
  /** Initial rect from the constructor. Stashed so `resetToDefaults`
   *  can re-apply it after clearing the user's persisted overrides
   *  — without this, reset would just clear localStorage and leave
   *  the panel wherever the user last dragged it. */
  private readonly defaultRect: DomPanelRect;
  /** Constructor-time base title — never changes after construction.
   *  Used as the prefix when a `titleSuffix` resolver returns a
   *  string (rendered as `"<baseTitle> - <resolved>"`); equals
   *  the displayed title when the suffix is `"none"`. */
  readonly baseTitle: string;
  /** Current displayed title. Equals `baseTitle` when the suffix
   *  is `"none"` or its resolver returns `null`; otherwise
   *  `"<baseTitle> - <resolved>"`. Mutates via `setTitle` (direct
   *  override) and `setTitleSuffix` (recomputed from base +
   *  resolver). Surfaced as `titleText` for back-compat with
   *  existing taskbar / popup code. */
  private _titleText: string;
  get titleText(): string { return this._titleText; }
  /** Per-suffix resolvers supplied by the constructor. Empty
   *  map = no suffix options exposed in the popup (the row
   *  hides). Each resolver returns the live string to append
   *  after `" - "` or `null` to suppress the suffix this tick. */
  private readonly _titleSuffixResolvers: Map<TitleSuffix, TitleSuffixResolver>;
  /** Active suffix mode. Persisted under `<storageKey>.titleSuffix`;
   *  defaults from `opts.titleSuffix ?? "none"` when no content
   *  default or localStorage value exists. */
  private _titleSuffix: TitleSuffix = "none";
  get titleSuffix(): TitleSuffix { return this._titleSuffix; }
  /** Just the *resolved* suffix portion — the string the active
   *  resolver returns, with no base-title prefix and no `" - "`
   *  separator. Empty when the suffix is `"none"`, the resolver
   *  returns null/undefined/"", or no resolver is registered.
   *  Used by the taskbar's icon-mode entries to append the live
   *  suffix next to the glyph so e.g. multiple game-view panels
   *  stay distinguishable (`👁 Wolf`, `👁 Vera`) instead of all
   *  showing the same icon. */
  get titleSuffixText(): string {
    if (this._titleSuffix === "none") return "";
    const resolved = this._titleSuffixResolvers.get(this._titleSuffix)?.();
    if (resolved === null || resolved === undefined || resolved === "") return "";
    return resolved;
  }
  /** Suffix modes the panel actually supports, derived from the
   *  resolver map. Always includes `"none"` (which doesn't need
   *  a resolver — it just shows the base title). The popup uses
   *  this to build the cycler options; if the array only has
   *  `"none"`, the row hides entirely. */
  get availableTitleSuffixes(): readonly TitleSuffix[] {
    return ["none", ...this._titleSuffixResolvers.keys()];
  }
  /** True when this panel asked to be pinned in its taskbar. Read by
   *  the taskbar at registration time; ignored thereafter. */
  readonly pinned: boolean;
  /** Constructor-seed icon — the value first written into
   *  `_taskbarIcon`. Stashed so `resetToDefaults` can revert the
   *  user's runtime override (set via the Taskbar Icon row in the
   *  popup) back to whatever the panel was built with. `null` =
   *  text-mode entry (uses panel title). */
  private readonly initialTaskbarIcon: string | null;
  /** Current taskbar icon. Mutable at runtime via
   *  `setTaskbarIcon` (the popup's Taskbar Icon row exposes a
   *  text input). `null` / empty string = text-mode entry. Read
   *  by `PanelTaskbar` for both initial registration and live
   *  updates via the `onTaskbarIconChange` subscription.
   *  Persisted under `<storageKey>.taskbarIcon`; an empty
   *  string round-trips as `null` (no icon). */
  private _taskbarIcon: string | null;
  /** Public accessor — returns the live icon, not the seed. */
  get taskbarIcon(): string | null { return this._taskbarIcon; }

  /** UI edit mode this panel participates in (if any). Null
   *  panels are inert during edit mode — the login form, for
   *  example. */
  private readonly uiEditMode: UiEditMode | null;
  /** Per-panel blacklist of `PanelSettingsPopup` row keys. Seeded
   *  from `opts.excludeSettings` plus base-class defaults (e.g.
   *  `"mask"` is default-hidden on plain `DomPanel`; `PixiPanel`
   *  removes it). Consulted by the popup via `isSettingHidden`.
   *  Mutable + protected so subclasses can opt back into a default-
   *  hidden row in their constructor body. */
  protected readonly _hiddenSettings: Set<PanelSettingKey>;
  /** DOM z-index band — see `DomZBand`. Frozen at construction
   *  time; gates which counter `bringToFront` advances and the
   *  clamp range used by `layerUp` / `layerDown`. */
  private readonly _zBand: DomZBand;
  /** Constructor-supplied seeds for the minimize / resize / close /
   *  pin toggles. Used by `resetToDefaults` to restore the panel
   *  to its "fresh from construction" state without re-reading
   *  `opts`. */
  private readonly initialMinimizable: boolean;
  private readonly initialResizable:   boolean;
  private readonly initialClosable:    boolean;
  private readonly initialPin:         PinMode;
  /** Constructor-time master switch — `false` means the title bar
   *  is never rendered (FormOverlay et al.). Runtime hides go
   *  through `titleBarHidden` instead. */
  private readonly titleBarAvailable: boolean;
  /** Action-button references kept so the edit-mode visibility
   *  pass can flip them on / off without rebuilding the DOM. Both
   *  are always created — the popup can toggle them on for any
   *  panel; constructor `minimizable` / `closable` opts now only
   *  seed the initial visibility. */
  protected readonly minimizeBtn:    HTMLButtonElement;
  protected readonly closeBtn:       HTMLButtonElement;
  /** Cleanup for the `UiEditMode.on` subscription, or null when
   *  edit mode wasn't wired. Called from `destroy()`. */
  private unsubUiEditMode: (() => void) | null = null;
  /** Window-resize handler that fires `rectChange` so consumers
   *  re-sync after a viewport reflow. Stored as a field so
   *  `destroy()` can detach it. */
  private readonly onWindowResize: () => void;

  private _open = false;
  private _minimized = false;
  /** Per-panel anchor toggled from the anchor cycler in the
   *  settings popup. Picks which corner of the panel stays put
   *  during a resize — the opposite corner is the grab handle.
   *  Independent of position (snap controls where the panel
   *  sits) and of drag (`_draggable` controls that). Persisted
   *  under `<storageKey>.anchor`. */
  private _anchor: AnchorMode = "top-left";
  /** Per-panel snap preset. `"none"` lets the user position the
   *  panel via drag / persisted rect; any other value snaps the
   *  panel to that corner of the safe area and forces
   *  `_draggable` off while active. Persisted under
   *  `<storageKey>.snap`. Reapplied on open, window resize, and
   *  on resize-gesture end. */
  private _snap: SnapMode = "none";
  /** Per-panel "can the user drag this panel" toggle. Drag is
   *  enabled only while this is `true` AND `_snap === "none"`
   *  (a non-none snap forces the panel's position and locks
   *  dragging off). Defaults `true` so panels behave like
   *  before-the-rework after construction. Persisted under
   *  `<storageKey>.draggable`. */
  private _draggable = true;
  /** User's "hide the title bar" preference toggled from the
   *  hide-title-bar button in edit mode. Forced to render the
   *  title bar anyway while edit mode is on. Persisted under
   *  `<storageKey>.titleBarHidden`. */
  private _titleBarHidden = false;
  /** Per-panel grid-snap toggle. While on, every drag and resize
   *  rounds to `uiEditMode.gridSize`. Persisted under
   *  `<storageKey>.gridSnap`. Read inside the pointer helpers'
   *  `snapStep` hooks so flipping the flag takes effect on the
   *  next pointermove without re-attaching listeners. */
  private _gridSnap = false;
  /** User-toggled "stencil-mask the body content" preference.
   *  Owned by `DomPanel` so the persistence / popup wiring is one
   *  place, but only `PixiPanel` does anything with it (subscribes
   *  via `onMaskedChange` to attach / detach the mask Graphics).
   *  Default true; `PixiPanel` reads it on construction to decide
   *  whether to allocate the mask at all. Persisted under
   *  `<storageKey>.masked`. Plain `DomPanel`s default-hide the
   *  popup row (see `isSettingHidden`) since toggling there is a
   *  no-op. */
  private _masked = true;
  /** User-toggled "enable minimize" preference. Effective minimize
   *  visibility = `minimizableCap && _minimizable`. Persisted
   *  under `<storageKey>.minimizable`. */
  private _minimizable = true;
  /** User-toggled "enable horizontal resize" preference. Gates the
   *  X-edge handle's visibility and gesture-start. The corner
   *  handle is gated on both axes (see `isResizable`). Persisted
   *  under `<storageKey>.resizableX`. */
  private _resizableX = true;
  /** User-toggled "enable vertical resize" preference. Gates the
   *  Y-edge handle's visibility and gesture-start *combined with
   *  the heightMode lock* — a non-`"off"` heightMode forces
   *  vertical resize off because the height is then computed,
   *  not user-owned. Persisted under `<storageKey>.resizableY`. */
  private _resizableY = true;
  /** User-toggled "enable close" preference. Mirrors `_minimizable`
   *  — the constructor's `closable` opt seeds the initial value;
   *  the popup's Close row flips it at runtime. Effective close
   *  visibility = just `_closable` (anchor no longer hides it).
   *  Persisted under `<storageKey>.closable`. */
  private _closable = true;
  /** User-toggled "hide the minimize button" preference. Independent
   *  from `_minimizable` — `_minimizable` controls the underlying
   *  capability; this flag controls only whether the title-bar
   *  button is drawn. Effective minimize-button visibility =
   *  `_minimizable && !_hideMinimizeBtn`. Lets the user keep a
   *  panel minimizable (via taskbar / future hotkeys) while
   *  decluttering its chrome. Persisted under
   *  `<storageKey>.hideMinimizeBtn`. */
  private _hideMinimizeBtn = false;
  /** User-toggled "hide the close button" preference. Same shape
   *  as `_hideMinimizeBtn` but for the close button. Effective
   *  close-button visibility = `_closable && !_hideCloseBtn`.
   *  Persisted under `<storageKey>.hideCloseBtn`. */
  private _hideCloseBtn = false;
  /** User-toggled "which taskbar to attach to" preset. `"none"`
   *  means unpinned (no taskbar entry); the four corners pick a
   *  bar + a side. Mutates via `setPin`, which (un)registers the
   *  panel with the appropriate `PanelTaskbar` via
   *  `PanelTaskbar.getByPosition`. Persisted under
   *  `<storageKey>.pin`. */
  private _pin: PinMode = "none";
  /** Per-panel height-lock preset. While anything other than
   *  `"off"`, the panel's height is reapplied on every relevant
   *  event (construction, window resize, anchor / minimize flip,
   *  resize gesture). `"full"` / `"half"` / `"quarter"` use the
   *  safe area between taskbar reserves; `"auto"` uses
   *  `_contentNaturalHeight` (which the content reports via
   *  `setContentNaturalHeight`). Persisted under
   *  `<storageKey>.heightMode`. */
  private _heightMode: HeightMode = "off";
  /** Content-reported natural height for `"auto"` mode. `null`
   *  means "no preference yet" (the content hasn't reported, or
   *  the panel isn't in auto mode). Pushed by the content's
   *  consumer (e.g. `MainLayout` mirroring
   *  `DetailsPanel.currentHeight` on every size-change event).
   *  Outer panel height in auto mode = title bar height +
   *  this value (the body is `flex: 1 1 auto`, so it absorbs the
   *  remaining vertical space). */
  private _contentNaturalHeight: number | null = null;
  /** Inline height stashed when the panel rolls up. Empty string
   *  means "no explicit height was set" — restoring to `""` hands
   *  the height back to flex layout. */
  private savedHeight: string | null = null;
  /** True when the most-recent minimize hid the entire panel
   *  (taskbar mode). On restore we need to know which way to
   *  un-minimize: clear `display: none` or re-apply `savedHeight`. */
  private hiddenForTaskbar = false;

  private readonly tabChangeListeners      = new Set<(id: string | null) => void>();
  private readonly rectChangeListeners     = new Set<(rect: DOMRect) => void>();
  private readonly minimizeChangeListeners = new Set<(min: boolean) => void>();
  private readonly openChangeListeners     = new Set<(open: boolean) => void>();
  private readonly focusListeners          = new Set<() => void>();
  private readonly destroyListeners        = new Set<() => void>();
  private readonly anchorChangeListeners   = new Set<(anchor: AnchorMode) => void>();
  private readonly minimizableChangeListeners = new Set<(minimizable: boolean) => void>();
  private readonly resizableChangeListeners   = new Set<(resizable: boolean) => void>();
  private readonly closableChangeListeners    = new Set<(closable: boolean) => void>();
  private readonly hideMinimizeBtnChangeListeners = new Set<(hidden: boolean) => void>();
  private readonly hideCloseBtnChangeListeners    = new Set<(hidden: boolean) => void>();
  private readonly pinChangeListeners         = new Set<(pin: PinMode) => void>();
  private readonly taskbarIconChangeListeners = new Set<(icon: string | null) => void>();
  private readonly titleChangeListeners       = new Set<(title: string) => void>();
  private readonly titleSuffixChangeListeners = new Set<(mode: TitleSuffix) => void>();
  private readonly heightModeChangeListeners  = new Set<(mode: HeightMode) => void>();
  private readonly snapChangeListeners        = new Set<(snap: SnapMode) => void>();
  private readonly draggableChangeListeners   = new Set<(draggable: boolean) => void>();
  private readonly maskedChangeListeners      = new Set<(masked: boolean) => void>();

  constructor(opts: DomPanelOptions) {
    this.storageKey = opts.storageKey ?? null;
    // `defaultsKey` falls back to `storageKey` so singleton panels
    // (chatPanel, debugPanel, …) get content-defaults lookup for
    // free without naming the key twice. Dynamic panels
    // (inventory:<surf>:<owner>, gameview:<id>) MUST pass an
    // explicit `defaultsKey` so every instance shares one entry.
    this.defaultsKey = opts.defaultsKey ?? opts.storageKey ?? null;
    this.minWidth   = opts.minWidth   ?? 200;
    this.minHeight  = opts.minHeight  ?? 100;
    this.baseTitle   = opts.title;
    // `_titleText` is reassigned after `_titleSuffix` resolves
    // below (post-contentDefaults). Seed with the base for the
    // window before then.
    this._titleText  = opts.title;
    this._titleSuffixResolvers = new Map(
      Object.entries(opts.titleSuffixResolvers ?? {}) as [TitleSuffix, TitleSuffixResolver][],
    );
    this.pinned      = opts.pinned      ?? false;
    this.initialTaskbarIcon = opts.taskbarIcon ?? null;
    // `_taskbarIcon` resolution happens after `contentDefaults` is
    // built below — it needs to layer `persisted > content > seed`
    // like every other field. Placeholder for now; reassigned in
    // the content-defaults block.
    this._taskbarIcon = this.initialTaskbarIcon;
    this.uiEditMode  = opts.uiEditMode  ?? null;
    this.titleBarAvailable = opts.showTitleBar ?? true;
    // Seed with the caller's blacklist plus `"mask"` — meaningless
    // on plain `DomPanel` (no Pixi mask to toggle). `PixiPanel`
    // re-enables the row in its constructor body.
    this._hiddenSettings = new Set<PanelSettingKey>(opts.excludeSettings ?? []);
    this._hiddenSettings.add("mask");
    this._zBand = opts.domZBand ?? "dom";
    this.initialMinimizable = opts.minimizable ?? true;
    this.initialResizable   = opts.resizable   ?? true;
    this.initialClosable    = opts.closable    ?? true;
    // Pin seed: prefer the new `pin` opt; fall back to the legacy
    // `taskbar` + `taskbarSide` pair so existing call sites
    // (ChatPanel, DebugPanel, SettingsMenu) keep working without
    // changes. `"none"` when neither is provided.
    this.initialPin = opts.pin ?? (opts.taskbar
      ? (`${opts.taskbar.position}-${opts.taskbarSide ?? "left"}` as PinMode)
      : "none");

    // Content-defaults snapshot for this panel. Pulled once into a
    // local so the `defaultedX` helpers don't re-walk the static
    // registry on every field init. Empty object when no entry
    // exists — every helper treats missing keys as "no override."
    const contentDefaults: PanelStateJSON = this.defaultsKey
      ? (DomPanel.panelDefaults?.[this.defaultsKey] ?? {})
      : {};

    // Restore persisted per-panel state (anchor, user title-bar
    // hide preference, grid-snap, minimize / resize / close / pin
    // toggles) before constructing chrome so the initial render
    // reflects saved state. `minimizable` / `resizable` / `closable`
    // constructor opts now seed the initial toggle value rather
    // than capping forever — users flip them via the settings
    // popup. Panels that should hide a row entirely list it in
    // `excludeSettings`. Each `defaultedX` helper layers content
    // defaults between the constructor seed and localStorage —
    // localStorage still wins so user changes persist.
    // localStorage value first (null when absent); fall through to
    // the content default and then the constructor / hard-coded
    // floor. `readAnchor` / `readSnap` always coerce to a valid
    // enum so we feed them whichever layer hit first; for `pin`
    // (which can return null) and `heightMode` (which takes an
    // explicit fallback) we thread the same precedence directly.
    const rawAnchor = this.storageGet("anchor");
    this._anchor         = rawAnchor !== null
      ? readAnchor(rawAnchor)
      : (contentDefaults.anchor ?? "top-left");
    this._titleBarHidden = this.defaultedBool("titleBarHidden", contentDefaults.titleBarHidden ?? false);
    this._gridSnap       = this.defaultedBool("gridSnap",       contentDefaults.gridSnap       ?? false);
    this._masked         = this.defaultedBool("masked",         contentDefaults.masked         ?? true);
    this._minimizable    = this.defaultedBool("minimizable",    contentDefaults.minimizable    ?? this.initialMinimizable);
    this._resizableX     = this.defaultedBool("resizableX",     contentDefaults.resizableX     ?? this.initialResizable);
    this._resizableY     = this.defaultedBool("resizableY",     contentDefaults.resizableY     ?? this.initialResizable);
    this._closable       = this.defaultedBool("closable",       contentDefaults.closable       ?? this.initialClosable);
    this._hideMinimizeBtn = this.defaultedBool("hideMinimizeBtn", contentDefaults.hideMinimizeBtn ?? false);
    this._hideCloseBtn    = this.defaultedBool("hideCloseBtn",    contentDefaults.hideCloseBtn    ?? false);
    this._pin            = readPin(this.storageGet("pin"))
      ?? (contentDefaults.pin ?? this.initialPin);
    this._heightMode     = readHeight(
      this.storageGet("heightMode"),
      contentDefaults.heightMode ?? opts.heightMode ?? "off",
    );
    const rawSnap = this.storageGet("snap");
    this._snap           = rawSnap !== null
      ? readSnap(rawSnap)
      : (contentDefaults.snap ?? "none");
    // Draggable defaults `true` for fresh panels; a non-none snap
    // override below forces it back to `false` so a saved snap
    // from a prior session still locks the panel even if the
    // draggable flag wasn't persisted alongside it.
    this._draggable      = this.defaultedBool("draggable", contentDefaults.draggable ?? true);
    if (this._snap !== "none") this._draggable = false;
    // Taskbar icon precedence: localStorage > content default >
    // constructor seed. Empty-string persistence round-trips back
    // to `null` (= text-mode entry).
    const rawIcon = this.storageGet("taskbarIcon");
    this._taskbarIcon = rawIcon === null
      ? (contentDefaults.taskbarIcon ?? this.initialTaskbarIcon)
      : (rawIcon === "" ? null : rawIcon);
    // Title suffix precedence: localStorage > content default >
    // constructor opt > "none". Compose the initial title from
    // base + resolver-resolved suffix here so the chrome span
    // shows the suffixed title on first render — without this
    // pass the titleEl would briefly show just the base before
    // the first popup interaction.
    this._titleSuffix = readTitleSuffix(this.storageGet("titleSuffix"))
      ?? contentDefaults.titleSuffix
      ?? opts.titleSuffix
      ?? "none";
    this._titleText  = this.composeTitle();

    this.panel = document.createElement("div");
    Object.assign(this.panel.style, PANEL_CSS);
    // Merge content-defaults rect over the constructor's
    // defaultRect, then `restorePosition` / `restoreSize` layer
    // localStorage on top of that. `defaultRect` field keeps the
    // merged value so `resetToDefaults` falls back to the same
    // "content defaults, then constructor defaults" stack.
    this.defaultRect = { ...(opts.defaultRect ?? {}), ...pickRectFields(contentDefaults) };
    this.applyRect(this.defaultRect);
    this.restorePosition();
    this.restoreSize();

    // ── Title bar ────────────────────────────────────────────────
    this.titlebar = document.createElement("div");
    Object.assign(this.titlebar.style, TITLEBAR_CSS);

    this.titleEl = document.createElement("span");
    Object.assign(this.titleEl.style, TITLE_CSS);
    // Render the composed `baseTitle + suffix` here, not the raw
    // `opts.title` — when a content default or persisted suffix
    // is active the chrome should show the full title on first
    // paint rather than briefly flashing the base alone.
    this.titleEl.textContent = this._titleText;
    this.titlebar.appendChild(this.titleEl);

    this.panel.appendChild(this.titlebar);

    // ── Action buttons (minimize / close + edit-mode trio) ───────
    // Sibling of the title bar (not a child) so they don't show up
    // as drag dead-zones inside `titlebar`. Absolutely positioned
    // over the panel's top-right corner via `ACTIONS_CSS`. The
    // edit-mode buttons (grid-snap / lock / hide-title-bar) are
    // built unconditionally and hidden by `refreshChrome` when the
    // panel isn't participating in edit mode; this keeps DOM
    // identity stable across mode flips. The visibility of every
    // button is recomputed in `refreshChrome` so a single helper
    // owns the rule set.
    this.actionsEl = document.createElement("div");
    Object.assign(this.actionsEl.style, ACTIONS_CSS);

    // Action button order, left to right: minimize, then close.
    // The edit-mode settings affordance lives on the panel-wide
    // click handler (see below) rather than as a dedicated ⛯
    // button — in edit mode the *whole panel* opens the
    // PanelSettingsPopup, so a dedicated button would be
    // redundant chrome.
    //
    // Per-panel controls (title bar, grid snap, anchor, layer
    // up / down, minimize toggle, resize toggle, reset) all live
    // as labeled rows in the popup itself.

    // Minimize button always created — visibility flips via
    // Minimize / Close buttons always created — visibility flips
    // via `refreshChrome` based on `_minimizable` / `_closable`,
    // both toggleable from the settings popup.
    this.minimizeBtn = this.makeActionButton("−", () => this.toggleMinimize(), "Minimize");
    this.actionsEl.appendChild(this.minimizeBtn);
    this.closeBtn = this.makeActionButton("✕", () => this.close(), "Close");
    this.actionsEl.appendChild(this.closeBtn);

    // Action buttons live inside the title bar (which is
    // `position: relative` per `TITLEBAR_CSS`) so absolute
    // positioning + `top: 50%` centers them within the title
    // bar's box rather than the whole panel's. The drag handler
    // below short-circuits when the pointerdown's target is
    // inside `actionsEl` to keep button clicks from initiating
    // drags.
    this.titlebar.appendChild(this.actionsEl);

    // ── Tab strip ────────────────────────────────────────────────
    // Sits between the title bar and the body. Below the title bar
    // (rather than inside it) so the whole title bar — minus the
    // action buttons — remains a clean drag handle. Hidden until
    // the first tab is registered.
    this.tabsEl = document.createElement("div");
    Object.assign(this.tabsEl.style, TABS_CSS);
    this.tabsEl.style.display = "none";
    this.panel.appendChild(this.tabsEl);

    // ── Body ─────────────────────────────────────────────────────
    this.body = document.createElement("div");
    Object.assign(this.body.style, BODY_CSS);
    this.panel.appendChild(this.body);

    // ── Resize corner ────────────────────────────────────────────
    // Always created — visibility (and grab-enable) flip via
    // `refreshChrome` based on per-axis toggles + heightMode
    // lock (see `effectiveResizeY` / `isResizable`). Position
    // (bottom-right by default; flips opposite the current
    // anchor in `applyAnchor`) lives in the same place.
    this.resizeCorner = document.createElement("div");
    Object.assign(this.resizeCorner.style, RESIZE_CORNER_CSS);
    this.panel.appendChild(this.resizeCorner);
    this.wireResize(this.resizeCorner, "both");

    // Edge handles sit beside the corner and resize one axis
    // each. Positioning is anchor-driven and gets re-applied
    // alongside the corner inside `applyAnchor`.
    this.resizeEdgeX = document.createElement("div");
    Object.assign(this.resizeEdgeX.style, RESIZE_EDGE_X_CSS);
    this.panel.appendChild(this.resizeEdgeX);
    this.wireResize(this.resizeEdgeX, "x");

    this.resizeEdgeY = document.createElement("div");
    Object.assign(this.resizeEdgeY.style, RESIZE_EDGE_Y_CSS);
    this.panel.appendChild(this.resizeEdgeY);
    this.wireResize(this.resizeEdgeY, "y");

    this.wireDrag();

    // Bringing the panel to the front happens on any pointerdown
    // anywhere inside it — clicking the body counts as a focus.
    this.panel.addEventListener("pointerdown", () => this.bringToFront());

    // While UI edit mode is on, clicking anywhere on the panel
    // opens the shared `PanelSettingsPopup` bound to this panel.
    // Uses `click` (not `pointerdown`) so an actual drag doesn't
    // also pop the settings — the browser only fires `click` when
    // pointer-up lands on the same element without significant
    // motion. Action buttons (minimize / close / tab buttons,
    // edit-mode rows inside the popup itself) all
    // `stopPropagation` in their handlers, so they don't bubble
    // here and the user's intent stays unambiguous.
    this.panel.addEventListener("click", () => {
      if (this.uiEditMode?.enabled) this.openSettings();
    });

    // Subscribe to UI edit-mode changes so chrome re-evaluates
    // whenever the user enters / leaves edit mode. The `on()`
    // helper fires once immediately, which doubles as the initial
    // chrome render — no separate seed call needed.
    if (this.uiEditMode) {
      this.unsubUiEditMode = this.uiEditMode.on(() => this.refreshChrome());
    } else {
      this.refreshChrome();
    }

    // Restore minimized state from storage after the chrome is built
    // so the visibility flip can target the real elements.
    if (this.loadSavedMinimized()) this.applyMinimized(true);

    // `restorePosition` now persists / restores all four CSS
    // anchors (`left` / `top` / `right` / `bottom`), so the
    // panel's pinned-corner CSS is already correct without a
    // call to `applyAnchor` here. We still need to position the
    // resize handles (corner + two edges) per the current anchor
    // — that's CSS-only and doesn't depend on the panel being
    // in the DOM.
    this.applyResizeHandleCss();

    // Taskbar registration is the last construction step so the
    // taskbar sees a fully-built panel (title, isOpen, isMinimized
    // all populated). The taskbar uses these to render
    // the entry's initial state. Looked up via `_pin` rather than
    // a stashed reference so a runtime `setPin` can swap bars.
    const initialBar = this.currentTaskbar();
    if (initialBar && !initialBar.destroyed) {
      initialBar.register(this);
    }

    // Window-resize wiring — CSS-anchored panels (right: 0 etc.)
    // and viewport-relative ones (calc(100vh - …)) reflow on
    // window resize, but neither the browser nor any other code
    // notifies rect-change subscribers. Fire `rectChange` so
    // `PixiPanel.syncRect` and external consumers (layouts that
    // reflow against the panel's rect) catch up. Reapply
    // `heightMode` first so a locked panel tracks the new
    // safe-area height before subscribers see the new rect.
    // Removed in `destroy`.
    this.onWindowResize = () => {
      this.applyHeight();
      this.applySnap();
      // A viewport shrink can leave a panel partly off-screen
      // (under a taskbar, past the right edge); pull it back
      // inside so the user doesn't lose it. Skipped while
      // snapped — `applySnap` above already owns the position.
      this.clampToSafeArea();
      this.fireRectChange();
    };
    window.addEventListener("resize", this.onWindowResize);

    // Final height pass: now that persisted size has been
    // restored, reapply `heightMode` so a locked panel overrides
    // whatever raw `height` came back from storage.
    this.applyHeight();

    // Module-level registry — let `resetAllToDefaults` find this
    // panel later. Paired with `destroy()` removal.
    allPanels.add(this);
  }

  /** Reset every live `DomPanel` to its constructor defaults — a
   *  recovery escape hatch for the settings menu when a user has
   *  wedged a panel off-screen or anchored it somewhere they can
   *  no longer reach. Iterates a snapshot of the registry so a
   *  panel that destroys itself mid-reset (none should, but be
   *  defensive) can't break the loop. */
  static resetAllToDefaults(): void {
    for (const panel of [...allPanels]) panel.resetToDefaults();
  }

  // ── Tabs ─────────────────────────────────────────────────────────

  /** Register a tab. `content` is appended to the panel body and
   *  hidden until the tab is active. If a saved active-tab exists in
   *  storage and matches `id`, the new tab becomes active. */
  addTab(id: string, icon: string, content: HTMLElement): void {
    const button = document.createElement("button");
    Object.assign(button.style, TAB_BTN_CSS);
    button.textContent = icon;
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      // Restoring on a tab click while minimized matches the OS
      // window-manager UX — the user wanted to see that tab, so we
      // surface it instead of silently switching behind a collapsed
      // title bar.
      if (this._minimized) this.restore();
      this.setActiveTab(id);
    });
    this.tabsEl.appendChild(button);
    this.tabsEl.style.display = "";

    content.style.display = "none";
    this.body.appendChild(content);

    this.tabs.set(id, { button, content });

    if (this._activeTabId === null) {
      const saved = this.loadSavedTab();
      this.setActiveTab(saved && this.tabs.has(saved) ? saved : id);
    }
  }

  /** Switch the active tab. No-op for unknown ids. */
  setActiveTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this._activeTabId = id;
    for (const [tabId, t] of this.tabs) {
      const active = tabId === id;
      t.content.style.display = active ? "" : "none";
      Object.assign(t.button.style, TAB_BTN_CSS);
      if (active) Object.assign(t.button.style, TAB_BTN_ACTIVE_CSS);
    }
    this.persistTab();
    for (const cb of this.tabChangeListeners) cb(id);
  }

  /** Install a single body element. Mutually exclusive with `addTab`
   *  — calling both leaves the body in a confused state. Used by
   *  panels (settings) that have no tabs. */
  setBody(el: HTMLElement): void {
    while (this.body.firstChild) this.body.removeChild(this.body.firstChild);
    this.body.appendChild(el);
  }

  /** Install a footer below the body (e.g. the chat input row). The
   *  footer keeps its natural height while the body absorbs the
   *  remaining vertical space. Hidden when the panel is minimized.
   *  Replacing an existing footer detaches the previous one. */
  setFooter(el: HTMLElement): void {
    if (this.footer) this.footer.remove();
    this.footer = el;
    // Default to the shared chrome backdrop so the footer stays
    // opaque now that the panel container is transparent. Callers
    // that need a custom footer color can override after this call.
    if (!el.style.background) el.style.background = FOOTER_BG;
    Object.assign(el.style, {
      flex: "0 0 auto",
      display: this._minimized ? "none" : "",
    });
    // Insert as the last in-flow child before the resize corner
    // (which is `position: absolute`, so DOM order doesn't matter
    // for the corner — but we still want the footer to render under
    // it visually). Appending to `this.panel` puts it after the
    // body in flex order, which is what we want.
    this.panel.appendChild(el);
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  open(): void {
    if (this._open) return;
    const host = document.getElementById(HOST_ID) ?? document.body;
    host.appendChild(this.panel);
    this._open = true;
    this.bringToFront();
    // Snap reads `getBoundingClientRect`, which only returns real
    // values once the panel is mounted. Construction-time
    // `applySnap` calls no-op on the detached node; this is the
    // first chance to actually move a snapped panel to its
    // corner. Re-pin anchor afterwards so the CSS rect anchors
    // reflect the post-snap rect.
    if (this._snap !== "none") {
      this.applySnap();
      this.applyAnchor();
    }
    // Persisted position from a prior session might be off-screen
    // now (smaller viewport, taskbar reserve added, etc.) — pull
    // the panel back into the safe area before the user sees it.
    // `clampToSafeArea` is a no-op when the panel is already in
    // bounds, so this is cheap for the common case.
    this.clampToSafeArea();
    for (const cb of this.openChangeListeners) cb(true);
    // Now that the panel is mounted, its `getBoundingClientRect`
    // returns real values for the first time. Fire `rectChange`
    // so subscribers (notably `PixiPanel.syncRect` and any
    // external consumer subscribed before `open`) lay out
    // against the actual rect rather than the pre-mount zeros.
    this.fireRectChange();
  }

  close(): void {
    if (!this._open) return;
    this.panel.remove();
    this._open = false;
    for (const cb of this.openChangeListeners) cb(false);
  }

  /** Bring the panel to the front of the stacking order, opening it
   *  first if it was closed. Public counterpart to `bringToFront` for
   *  external focus requests (e.g. a taskbar click). */
  focus(): void {
    if (!this._open) {
      this.open();
      return;
    }
    this.bringToFront();
  }

  toggle(): void {
    if (this._open) this.close(); else this.open();
  }

  minimize(): void {
    if (this._minimized) return;
    this.applyMinimized(true);
  }

  restore(): void {
    if (!this._minimized) return;
    this.applyMinimized(false);
  }

  toggleMinimize(): void {
    if (this._minimized) this.restore(); else this.minimize();
  }

  /** Update the panel's displayed title. Writes the chrome's
   *  live span, updates `titleText`, and fires `onTitleChange`
   *  so the taskbar entry / Pixi chrome / popup heading
   *  re-sync. Subclasses (`PixiPanel`) override to also push
   *  the new string onto their Pixi-rendered title node.
   *
   *  Direct callers (e.g. `BlueprintsPanel` pushing a live
   *  capacity counter) win until the next `setTitleSuffix`
   *  call — at which point the title gets recomposed from
   *  `baseTitle + resolved suffix` and any external override
   *  is dropped. Panels with externally-driven dynamic titles
   *  should exclude the `"titleSuffix"` row from the popup. */
  setTitle(text: string): void {
    if (this._titleText === text) return;
    this._titleText = text;
    this.titleEl.textContent = text;
    for (const cb of this.titleChangeListeners) cb(text);
  }

  /** Change the title suffix mode. Recomposes the displayed
   *  title from `baseTitle + resolver(<mode>)?()` (mode `"none"`
   *  drops the suffix entirely) and pushes it through `setTitle`,
   *  so the chrome / taskbar / popup all re-sync via the title
   *  change event. Persists under `<storageKey>.titleSuffix`. */
  setTitleSuffix(mode: TitleSuffix): void {
    if (this._titleSuffix === mode) return;
    this._titleSuffix = mode;
    this.storageSet("titleSuffix", mode);
    this.setTitle(this.composeTitle());
    for (const cb of this.titleSuffixChangeListeners) cb(mode);
  }

  /** Compose the displayed title from the current `baseTitle` +
   *  suffix mode. `"none"` (or a resolver returning `null` /
   *  empty) gives just the base; otherwise `"<base> - <resolved>"`. */
  private composeTitle(): string {
    if (this._titleSuffix === "none") return this.baseTitle;
    const resolver = this._titleSuffixResolvers.get(this._titleSuffix);
    const resolved = resolver?.();
    if (resolved === null || resolved === undefined || resolved === "") {
      return this.baseTitle;
    }
    return `${this.baseTitle} - ${resolved}`;
  }

  destroy(): void {
    this.close();
    const bar = this.currentTaskbar();
    if (bar && !bar.destroyed) bar.unregister(this);
    this.unsubUiEditMode?.();
    this.unsubUiEditMode = null;
    window.removeEventListener("resize", this.onWindowResize);
    // Fire destroy listeners before clearing them so PanelManager
    // (and any other observer) can unregister this panel from its
    // own bookkeeping. Snapshot first so a listener that mutates the
    // set during iteration doesn't skip siblings.
    const destroyCbs = [...this.destroyListeners];
    this.destroyListeners.clear();
    for (const cb of destroyCbs) {
      try { cb(); } catch (err) { console.error("[DomPanel] destroy listener threw", err); }
    }
    this.tabChangeListeners.clear();
    this.rectChangeListeners.clear();
    this.minimizeChangeListeners.clear();
    this.openChangeListeners.clear();
    this.focusListeners.clear();
    this.anchorChangeListeners.clear();
    this.minimizableChangeListeners.clear();
    this.resizableChangeListeners.clear();
    this.closableChangeListeners.clear();
    this.hideMinimizeBtnChangeListeners.clear();
    this.hideCloseBtnChangeListeners.clear();
    this.heightModeChangeListeners.clear();
    this.snapChangeListeners.clear();
    this.draggableChangeListeners.clear();
    this.taskbarIconChangeListeners.clear();
    this.titleChangeListeners.clear();
    this.titleSuffixChangeListeners.clear();
    allPanels.delete(this);
  }

  // ── Queries ──────────────────────────────────────────────────────

  get isOpen(): boolean { return this._open; }
  get isMinimized(): boolean { return this._minimized; }
  /** Current anchor preset. Determines which panel corner stays
   *  put during a resize gesture; the opposite corner is the
   *  grab handle. Independent of position (snap controls that)
   *  and of drag (`isDraggable` controls that). */
  get anchor(): AnchorMode { return this._anchor; }
  /** Current snap preset. `"none"` means the user owns the
   *  panel's position; the four corners glue the panel to that
   *  corner of the safe area and force `isDraggable` off. */
  get snap(): SnapMode { return this._snap; }
  /** Whether the panel responds to drag gestures right now. Read
   *  by `wireDrag.shouldStart`. Forced `false` while snapped; the
   *  user's own toggle controls it the rest of the time. */
  get isDraggable(): boolean { return this._draggable && this._snap === "none"; }
  get isGridSnap(): boolean { return this._gridSnap; }
  get isTitleBarHidden(): boolean { return this._titleBarHidden; }
  /** Whether minimize is currently enabled. Reflects the user-
   *  toggleable preference (seeded from the constructor's
   *  `minimizable` opt). No longer hard-capped — every panel
   *  can be made minimize-capable via the settings popup. */
  get isMinimizable(): boolean { return this._minimizable; }
  /** Raw user toggle for horizontal resize. Read by the popup
   *  for its Resize Horizontal row glyph. The X-edge handle is
   *  enabled exactly when this is true; the corner handle
   *  requires both this and Y enabled (see `isResizable`). */
  get isResizableX(): boolean { return this._resizableX; }
  /** Raw user toggle for vertical resize. Read by the popup for
   *  its Resize Vertical row glyph. The *effective* Y-edge
   *  enable also requires `heightMode === "off"` — a non-`"off"`
   *  height lock fixes the height, so the Y handle hides even
   *  when the user has the toggle on. See `effectiveResizeY`. */
  get isResizableY(): boolean { return this._resizableY; }
  /** Whether the corner-grab handle (both-axis resize) is
   *  enabled right now. Derived: both X and Y must be toggled
   *  on AND the height mustn't be locked. Used by `PixiPanel`
   *  to gate the Pixi corner indicator. */
  get isResizable(): boolean {
    return this._resizableX && this.effectiveResizeY();
  }
  /** Whether close is currently enabled. Mirrors `isMinimizable`'s
   *  shape — user-toggleable via the popup; the constructor's
   *  `closable` opt is just the initial value. Close button still
   *  also hides while the panel is anchored (anchored panels are
   *  fixtures). */
  get isClosable(): boolean { return this._closable; }
  /** Raw "user wants the minimize button hidden" flag. Independent
   *  from `isMinimizable` (the capability). The popup's "Hide
   *  Minimize" row drives this. */
  get isMinimizeBtnHidden(): boolean { return this._hideMinimizeBtn; }
  /** Raw "user wants the close button hidden" flag. Same shape as
   *  `isMinimizeBtnHidden` but for close. */
  get isCloseBtnHidden(): boolean { return this._hideCloseBtn; }
  /** Effective minimize-button visibility — both the capability
   *  toggle and the hide-button toggle must agree. PixiPanel
   *  mirrors this onto its Pixi chrome. */
  get isMinimizeBtnVisible(): boolean { return this._minimizable && !this._hideMinimizeBtn; }
  /** Effective close-button visibility. */
  get isCloseBtnVisible(): boolean { return this._closable && !this._hideCloseBtn; }
  /** Current Pin preset. `"none"` means unpinned (no taskbar
   *  entry); the four corners encode `taskbar position` +
   *  `taskbar side`. */
  get pin(): PinMode { return this._pin; }
  /** Which side of the taskbar this panel's entry attaches to.
   *  Derived from `_pin`; defaults to `"left"` when unpinned
   *  (irrelevant in that case — no entry to place). */
  get taskbarSide(): PinSide { return pinSide(this._pin); }
  /** Live taskbar this panel is currently pinned to, or `null`
   *  when unpinned. Looked up by position via the module-level
   *  registry rather than stored, so `setPin` can swap bars
   *  without re-threading a reference. */
  currentTaskbar(): PanelTaskbar | null {
    const pos = pinPosition(this._pin);
    return pos ? PanelTaskbar.getByPosition(pos) : null;
  }
  /** Whether the `PanelSettingsPopup` should suppress the row
   *  for `key`. `false` by default; `true` when the panel was
   *  constructed with `excludeSettings: […]` listing `key`. */
  isSettingHidden(key: PanelSettingKey): boolean {
    return this._hiddenSettings.has(key);
  }
  /** Current height-lock preset. `"off"` means the panel
   *  resizes freely; the other three lock height to that
   *  fraction of the safe area. */
  get heightMode(): HeightMode { return this._heightMode; }
  get activeTabId(): string | null { return this._activeTabId; }
  /** Body region bounding rect in viewport pixels. Title bar and
   *  tab strip are excluded. Used by `PixiPanel` to mirror the body
   *  into a Pixi container; also handy for any consumer that needs
   *  to align an external overlay against the panel's content area. */
  get bodyRect(): DOMRect { return this.body.getBoundingClientRect(); }

  // ── Events ───────────────────────────────────────────────────────

  onTabChange(cb: (id: string | null) => void): () => void {
    this.tabChangeListeners.add(cb);
    return () => this.tabChangeListeners.delete(cb);
  }

  onRectChange(cb: (rect: DOMRect) => void): () => void {
    this.rectChangeListeners.add(cb);
    return () => this.rectChangeListeners.delete(cb);
  }

  onMinimizeChange(cb: (minimized: boolean) => void): () => void {
    this.minimizeChangeListeners.add(cb);
    return () => this.minimizeChangeListeners.delete(cb);
  }

  onOpenChange(cb: (open: boolean) => void): () => void {
    this.openChangeListeners.add(cb);
    return () => this.openChangeListeners.delete(cb);
  }

  /** Fires whenever the panel comes to the front of the stacking
   *  order (open / pointerdown / `focus()`). Used by the taskbar to
   *  highlight the active entry. */
  onFocus(cb: () => void): () => void {
    this.focusListeners.add(cb);
    return () => this.focusListeners.delete(cb);
  }

  /** Fires once, after `destroy()` has torn down DOM + taskbar entry
   *  and cleared internal listeners. PanelManager uses this to
   *  unregister the panel from its registry without each caller
   *  having to plumb a callback through the factory. */
  onDestroy(cb: () => void): () => void {
    this.destroyListeners.add(cb);
    return () => this.destroyListeners.delete(cb);
  }

  /** Fires whenever the anchor changes. Used by `PanelSettingsPopup`
   *  to keep its cycler in sync if the anchor ever mutates from
   *  outside the popup. */
  onAnchorChange(cb: (anchor: AnchorMode) => void): () => void {
    this.anchorChangeListeners.add(cb);
    return () => this.anchorChangeListeners.delete(cb);
  }

  /** Fires whenever the user's minimize-enabled toggle flips.
   *  Used by the taskbar to hide / re-show the panel's entry —
   *  the bar shows entries only for panels that can be
   *  minimized. */
  onMinimizableChange(cb: (minimizable: boolean) => void): () => void {
    this.minimizableChangeListeners.add(cb);
    return () => this.minimizableChangeListeners.delete(cb);
  }

  /** Fires when the user's close-enabled toggle flips. Symmetric
   *  to `onMinimizableChange`; the popup's Close row drives this. */
  onClosableChange(cb: (closable: boolean) => void): () => void {
    this.closableChangeListeners.add(cb);
    return () => this.closableChangeListeners.delete(cb);
  }

  /** Fires when the user's "hide minimize button" toggle flips.
   *  PixiPanel subscribes to refresh its chrome's button
   *  visibility — the DOM side is handled by `refreshChrome`
   *  which `toggleHideMinimizeBtn` calls directly. */
  onHideMinimizeBtnChange(cb: (hidden: boolean) => void): () => void {
    this.hideMinimizeBtnChangeListeners.add(cb);
    return () => this.hideMinimizeBtnChangeListeners.delete(cb);
  }

  /** Fires when the user's "hide close button" toggle flips.
   *  Symmetric to `onHideMinimizeBtnChange`. */
  onHideCloseBtnChange(cb: (hidden: boolean) => void): () => void {
    this.hideCloseBtnChangeListeners.add(cb);
    return () => this.hideCloseBtnChangeListeners.delete(cb);
  }

  /** Fires when the user's Pin preset changes (via `setPin` from
   *  the popup, or reset-to-defaults). Used by the popup to keep
   *  its Pin cycler in sync if pin mutates from outside. */
  onPinChange(cb: (pin: PinMode) => void): () => void {
    this.pinChangeListeners.add(cb);
    return () => this.pinChangeListeners.delete(cb);
  }

  /** Fires when the user's taskbar icon changes (via the popup
   *  Taskbar Icon row or `resetToDefaults`). `null` means
   *  "fall back to text mode" — `PanelTaskbar` swaps the entry
   *  button between icon-square and wide-text shape on each
   *  fire. */
  onTaskbarIconChange(cb: (icon: string | null) => void): () => void {
    this.taskbarIconChangeListeners.add(cb);
    return () => this.taskbarIconChangeListeners.delete(cb);
  }

  /** Fires whenever the displayed title changes — direct
   *  `setTitle` calls, `setTitleSuffix` recompositions, and
   *  `resetToDefaults` all route through here. The `PanelTaskbar`
   *  entry, `PixiPanel` Pixi chrome, and `PanelSettingsPopup`
   *  heading subscribe so they stay in sync without polling. */
  onTitleChange(cb: (title: string) => void): () => void {
    this.titleChangeListeners.add(cb);
    return () => this.titleChangeListeners.delete(cb);
  }

  /** Fires when the suffix mode itself flips (`"none"` → `"player"`
   *  etc.), independent of whether the resolved string differs.
   *  The popup's Title Suffix cycler subscribes so it re-syncs on
   *  reset / external mutation. */
  onTitleSuffixChange(cb: (mode: TitleSuffix) => void): () => void {
    this.titleSuffixChangeListeners.add(cb);
    return () => this.titleSuffixChangeListeners.delete(cb);
  }

  /** Fires whenever the user's resize-enabled toggle flips. Used
   *  by `PixiPanel` to hide / re-show its Pixi resize indicator
   *  alongside the DOM corner. */
  onResizableChange(cb: (resizable: boolean) => void): () => void {
    this.resizableChangeListeners.add(cb);
    return () => this.resizableChangeListeners.delete(cb);
  }

  /** Fires whenever the height-lock preset changes. Used by
   *  `PanelSettingsPopup` to keep its cycler in sync if the mode
   *  ever mutates from outside the popup. */
  onHeightModeChange(cb: (mode: HeightMode) => void): () => void {
    this.heightModeChangeListeners.add(cb);
    return () => this.heightModeChangeListeners.delete(cb);
  }

  /** Fires whenever the snap preset changes. Used by
   *  `PanelSettingsPopup` to keep its Snap cycler in sync, and
   *  to refresh the Draggable button since flipping snap to
   *  non-none forces draggable off as a side effect. */
  onSnapChange(cb: (snap: SnapMode) => void): () => void {
    this.snapChangeListeners.add(cb);
    return () => this.snapChangeListeners.delete(cb);
  }

  /** Fires whenever the user-facing draggable toggle flips. Note
   *  this fires on the user toggle even if the *effective*
   *  `isDraggable` is locked off by snap — the popup needs the
   *  raw flag to render its button glyph; the cursor / gate use
   *  `isDraggable`. */
  onDraggableChange(cb: (draggable: boolean) => void): () => void {
    this.draggableChangeListeners.add(cb);
    return () => this.draggableChangeListeners.delete(cb);
  }

  // ── Internals ────────────────────────────────────────────────────

  private makeActionButton(
    label: string,
    onClick: () => void,
    tooltip?: string,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    Object.assign(btn.style, ACTION_BTN_CSS);
    btn.textContent = label;
    if (tooltip) btn.title = tooltip;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  private applyRect(r: DomPanelRect): void {
    if (r.left   !== undefined) this.panel.style.left   = r.left;
    if (r.top    !== undefined) this.panel.style.top    = r.top;
    if (r.right  !== undefined) this.panel.style.right  = r.right;
    if (r.bottom !== undefined) this.panel.style.bottom = r.bottom;
    if (r.width  !== undefined) this.panel.style.width  = r.width;
    if (r.height !== undefined) this.panel.style.height = r.height;
  }

  private applyMinimized(min: boolean): void {
    this._minimized = min;
    // Mode selection: minimize-to-taskbar if a live taskbar is
    // attached, otherwise roll up in place. Decided per call (not
    // cached) so a taskbar that was destroyed between the panel's
    // construction and now gracefully falls back to roll-up.
    const bar = this.currentTaskbar();
    const useTaskbar = !!(bar && !bar.destroyed);
    if (min) {
      if (useTaskbar) {
        this.hiddenForTaskbar = true;
        this.panel.style.display = "none";
      } else {
        this.savedHeight = this.panel.style.height;
        this.panel.style.height = "";
      }
    } else {
      if (this.hiddenForTaskbar) {
        // Restore to `"flex"` rather than `""` — `PANEL_CSS` sets
        // `display: flex` inline at construction, and the panel
        // div has no stylesheet rule to fall back on. Clearing the
        // inline would leave it at the user-agent default
        // (`block`), which kills the flex children's stretch and
        // squishes the body to zero height even though the panel
        // border still shows.
        this.panel.style.display = "flex";
        this.hiddenForTaskbar = false;
      }
      if (this.savedHeight !== null) {
        this.panel.style.height = this.savedHeight;
        this.savedHeight = null;
      }
    }
    this.body.style.display = min ? "none" : "";
    if (this.footer) this.footer.style.display = min ? "none" : "";
    // Tabs row hides too — it's content, not chrome, now that it
    // sits below the title bar. The rolled-up panel collapses to
    // just the title bar's height; the hidden-for-taskbar panel
    // doesn't render at all but the inner flips keep state
    // consistent for the restore path.
    if (this.tabs.size > 0) {
      this.tabsEl.style.display = min ? "none" : "";
    }
    if (min) {
      this.resizeCorner.style.display = "none";
      this.resizeEdgeX.style.display  = "none";
      this.resizeEdgeY.style.display  = "none";
    }
    this.minimizeBtn.textContent = min ? "+" : "−";
    // Re-run the full chrome pass so resize-corner / button
    // visibility reflects lock + minimize together.
    this.refreshChrome();
    this.persistMinimized();
    for (const cb of this.minimizeChangeListeners) cb(min);
    this.fireRectChange();
  }

  private bringToFront(): void {
    nextZByBand[this._zBand] += 1;
    this.panel.style.zIndex = String(nextZByBand[this._zBand]);
    for (const cb of this.focusListeners) cb();
  }

  private wireDrag(): void {
    attachDrag(this.titlebar, this.panel, {
      shouldStart: (e) => {
        if (!this.isDraggable) return false;
        // Action buttons live inside the title bar now (so they
        // can vertical-center against it). Their pointerdowns
        // bubble up to this handler; skip the drag when the
        // press originated inside the actions container so a
        // minimize / close click doesn't also start a drag.
        const target = e.target as HTMLElement | null;
        if (target && this.actionsEl.contains(target)) return false;
        return true;
      },
      snapGrid:      () => this.activeSnapGrid(),
      clampPosition: () => this.dragClampBounds(),
      onMove: () => this.fireRectChange(),
      onEnd:  () => this.persistPosition(),
    });
  }

  /** Bounds the drag helper clamps the panel's left/top into on
   *  every pointermove. Keeps the whole panel inside the safe
   *  area (viewport minus taskbar reserves) so the user can't
   *  drag a panel off-screen and lose it. Reads `getBoundingClientRect`
   *  each call so a window-resize mid-drag picks up the new
   *  viewport size. */
  private dragClampBounds(): { minLeft: number; minTop: number; maxLeft: number; maxTop: number } {
    const rect = this.panel.getBoundingClientRect();
    const reservedTop    = this.uiEditMode?.reservedTop    ?? 0;
    const reservedBottom = this.uiEditMode?.reservedBottom ?? 0;
    const safeBottom = window.innerHeight - reservedBottom;
    return {
      minLeft: 0,
      minTop:  reservedTop,
      maxLeft: window.innerWidth - rect.width,
      maxTop:  safeBottom - rect.height,
    };
  }

  private wireResize(handle: HTMLDivElement, axis: "both" | "x" | "y"): void {
    attachResize(handle, this.panel, {
      minWidth:  this.minWidth,
      minHeight: this.minHeight,
      // Per-handle gate: the corner needs both axes (and an
      // unlocked height); the X-edge needs only its own toggle;
      // the Y-edge needs its toggle AND `heightMode === "off"`
      // (a non-`"off"` height lock leaves no degree of freedom
      // for a vertical drag).
      shouldStart: () =>
        axis === "x" ? this._resizableX
      : axis === "y" ? this.effectiveResizeY()
      :                this.isResizable,
      snapGrid:    () => this.activeSnapGrid(),
      // Edge handles share the corner's sign mapping — the X-edge
      // sits on the same side as the corner, so `endsWith("r")` /
      // `startsWith("b")` give the right cursor-delta direction for
      // both. The `axis` arg below is what scopes the write to a
      // single dimension.
      corner:      () => this.currentResizeCorner(),
      axis:        () => axis,
      clampSize:   () => this.resizeClampSize(),
      // While `heightMode` is locked the user only gets width
      // resize; reapply the locked height after every move so the
      // corner's height update is immediately overridden.
      // Snap re-applies on `onEnd` (not `onMove`) so the panel
      // doesn't visibly jitter back to its corner during the drag
      // — it lands there once the user releases.
      onMove: () => { this.applyHeight(); this.fireRectChange(); },
      onEnd:  () => {
        this.applyHeight();
        this.applySnap();
        this.persistSize();
      },
    });
  }

  /** Maximum width / height the resize gesture may grow the
   *  panel to before the moving edge pushes past the safe-area
   *  boundary. The anchored corner stays put during resize, so
   *  the cap is the distance from that corner to the opposite
   *  safe-area edge — different per anchor (top-left grows
   *  right + down to viewport edges; bottom-right grows left +
   *  up to taskbar-reserved edges; etc.). Read fresh each
   *  pointermove so a mid-resize viewport reflow takes effect. */
  private resizeClampSize(): { maxWidth: number; maxHeight: number } {
    const rect = this.panel.getBoundingClientRect();
    const reservedTop    = this.uiEditMode?.reservedTop    ?? 0;
    const reservedBottom = this.uiEditMode?.reservedBottom ?? 0;
    const safeBottom = window.innerHeight - reservedBottom;
    const growsRight = this._anchor === "top-left"   || this._anchor === "bottom-left";
    const growsDown  = this._anchor === "top-left"   || this._anchor === "top-right";
    const maxWidth  = growsRight ? window.innerWidth - rect.left : rect.right;
    const maxHeight = growsDown  ? safeBottom - rect.top         : rect.bottom - reservedTop;
    return { maxWidth, maxHeight };
  }

  /** Current snap grid, or `null` if this panel isn't in grid-
   *  snap mode. Read on every pointermove by the drag / resize
   *  helpers — flipping the per-panel flag takes effect on the
   *  next move without re-attaching anything. The grid is read
   *  fresh from `UiEditMode` each time, so window resizes reshape
   *  it automatically. */
  private activeSnapGrid(): SnapGrid | null {
    if (!this._gridSnap || !this.uiEditMode) return null;
    return this.uiEditMode.getGrid();
  }

  // ── Edit-mode actions ───────────────────────────────────────────

  /** Toggle the per-panel grid-snap mode. Flipping it on:
   *   - aligns the current rect to the grid in one pass (so the
   *     user gets immediate visual feedback);
   *   - flips a flag that the drag / resize helpers read on every
   *     pointermove, so subsequent gestures snap too.
   *  Flipping it off leaves the rect where it lies — drag /
   *  resize go back to pixel-perfect motion. */
  toggleGridSnap(): void {
    this._gridSnap = !this._gridSnap;
    this.storageSet("gridSnap", this._gridSnap ? "1" : "0");
    if (this._gridSnap) this.snapToGrid();
    this.refreshChrome();
  }

  /** Whether the panel body's Pixi content is currently stencil-
   *  masked to the body rect. `true` by default; `PixiPanel` reads
   *  this on construction and subscribes via `onMaskedChange` to
   *  attach / detach the mask Graphics live. No-op on plain
   *  `DomPanel`s. */
  get isMasked(): boolean { return this._masked; }

  /** Toggle the body mask. Fires `onMaskedChange` so `PixiPanel`
   *  reattaches / detaches the mask Graphics; non-Pixi panels just
   *  persist the flag (toggle is a no-op visually, and the row is
   *  default-hidden for them — see `isSettingHidden`). */
  toggleMasked(): void {
    this._masked = !this._masked;
    this.storageSet("masked", this._masked ? "1" : "0");
    for (const cb of this.maskedChangeListeners) cb(this._masked);
  }

  /** Fires when the mask toggle flips. `PixiPanel` subscribes to
   *  attach / detach its mask Graphics so the drawcall saving lands
   *  without re-creating the panel. */
  onMaskedChange(cb: (masked: boolean) => void): () => void {
    this.maskedChangeListeners.add(cb);
    return () => this.maskedChangeListeners.delete(cb);
  }

  /** Round the panel's `left` / `top` / `width` / `height` to the
   *  current grid step in one pass. Used internally by
   *  `toggleGridSnap` to align on activation; safe to call
   *  directly if a caller ever needs a one-shot snap. No-op when
   *  the panel isn't wired to a `UiEditMode`. */
  snapToGrid(): void {
    if (!this.uiEditMode) return;
    const grid = this.uiEditMode.getGrid();
    if (grid.stepX <= 0 || grid.stepY <= 0) return;
    const r = this.panel.getBoundingClientRect();
    const left = grid.originX +
      Math.round((r.left - grid.originX) / grid.stepX) * grid.stepX;
    const top  = grid.originY +
      Math.round((r.top  - grid.originY) / grid.stepY) * grid.stepY;
    const width  = Math.max(this.minWidth,  Math.round(r.width  / grid.stepX) * grid.stepX);
    const height = Math.max(this.minHeight, Math.round(r.height / grid.stepY) * grid.stepY);
    // Write the snapped rect via the top-left + width/height
    // anchors first. For an anchored panel this momentarily
    // clobbers the corner-pinning CSS (e.g. a top-right anchor's
    // `right: Xpx` flips to `auto`) — `applyAnchor` immediately
    // below reads the post-snap rect and re-pins the chosen
    // corner with the right CSS, so the panel ends up snapped to
    // the grid *and* still anchored. Without the re-anchor pass
    // the resize-corner math would fight the CSS and resize
    // would visually go the wrong way.
    this.panel.style.left   = `${left}px`;
    this.panel.style.top    = `${top}px`;
    this.panel.style.right  = "auto";
    this.panel.style.bottom = "auto";
    this.panel.style.width  = `${width}px`;
    this.panel.style.height = `${height}px`;
    this.applyAnchor();
    this.persistSize();
  }

  /** Set the panel's anchor. `"none"` lets the panel drag freely;
   *  any other value locks the panel's position and makes that
   *  corner the pivot for resize (the opposite corner is the
   *  grab handle). The panel doesn't visually move when the
   *  anchor changes — `applyAnchor` reads the current rect and
   *  pins the chosen corner where the panel already sits. */
  setAnchor(anchor: AnchorMode): void {
    if (this._anchor === anchor) return;
    this._anchor = anchor;
    this.storageSet("anchor", anchor);
    this.applyAnchor();
    this.refreshChrome();
    for (const cb of this.anchorChangeListeners) cb(anchor);
  }

  /** Push the current anchor preset into CSS positioning + repaint
   *  the resize corner. Reads the panel's *current* bounding rect
   *  and writes CSS that keeps the panel at that screen position —
   *  switching anchors no longer moves the panel; it just pins
   *  whichever corner the user picked. The opposite anchors flip
   *  to `"auto"` so width / height continue to drive the far
   *  edges of the box. Skips the rect-derived writes when the
   *  panel isn't yet in the DOM (`isConnected === false`) — no
   *  layout to measure yet. */
  private applyAnchor(): void {
    if (this.panel.isConnected) {
      const rect  = this.panel.getBoundingClientRect();
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;
      if (this._anchor === "top-left") {
        // Top-left anchor: pin via top / left, clear right / bottom
        // so the panel doesn't get pulled around by a viewport
        // reflow. Resize handle ends up at bottom-right (see
        // `currentResizeCorner`).
        this.panel.style.top    = `${rect.top}px`;
        this.panel.style.left   = `${rect.left}px`;
        this.panel.style.right  = "auto";
        this.panel.style.bottom = "auto";
      } else if (this._anchor === "top-right") {
        this.panel.style.top    = `${rect.top}px`;
        this.panel.style.right  = `${viewW - rect.right}px`;
        this.panel.style.left   = "auto";
        this.panel.style.bottom = "auto";
      } else if (this._anchor === "bottom-left") {
        this.panel.style.bottom = `${viewH - rect.bottom}px`;
        this.panel.style.left   = `${rect.left}px`;
        this.panel.style.right  = "auto";
        this.panel.style.top    = "auto";
      } else {
        // bottom-right
        this.panel.style.bottom = `${viewH - rect.bottom}px`;
        this.panel.style.right  = `${viewW - rect.right}px`;
        this.panel.style.left   = "auto";
        this.panel.style.top    = "auto";
      }
    }
    // Move the resize handles (corner + two adjacent edges) to
    // the corner / sides opposite the anchor — grabbing any of
    // them grows the panel away from the anchored point, keeping
    // the anchored corner stationary. CSS-only, safe whether the
    // panel is connected or not.
    this.applyResizeHandleCss();
    this.fireRectChange();
    this.persistPosition();
  }

  /** Which corner of the panel the resize handle currently lives
   *  in — opposite the anchor so the anchored corner stays put
   *  during a resize. Defaults to `"br"` for unanchored panels,
   *  matching the classic "drag the bottom-right corner to grow"
   *  behaviour. */
  private currentResizeCorner(): "tl" | "tr" | "bl" | "br" {
    switch (this._anchor) {
      case "top-right":    return "bl";
      case "bottom-left":  return "tr";
      case "bottom-right": return "tl";
      case "top-left":
      default:             return "br";
    }
  }

  /** Reposition all three resize handles — corner + adjacent X
   *  and Y edges — to the corner / sides opposite the current
   *  anchor. Pulled out so the constructor and `applyAnchor`
   *  share one source of truth for which edges are live. */
  private applyResizeHandleCss(): void {
    const corner = this.currentResizeCorner();
    Object.assign(this.resizeCorner.style, resizeCornerCssFor(corner));
    Object.assign(this.resizeEdgeX.style,  edgeXCssFor(corner));
    Object.assign(this.resizeEdgeY.style,  edgeYCssFor(corner));
  }

  /** Flip the user's hide-the-title-bar preference. The actual
   *  title-bar visibility re-evaluation in `refreshChrome` also
   *  honors the active UI-edit-mode flag — while editing, the
   *  title bar stays visible regardless of this preference. */
  toggleTitleBarHidden(): void {
    this._titleBarHidden = !this._titleBarHidden;
    this.storageSet("titleBarHidden", this._titleBarHidden ? "1" : "0");
    this.refreshChrome();
    // Hiding the title bar lets the flex body grow into its
    // slot — the body's bounding rect changes, so PixiPanel
    // (and any other rectChange subscriber that mirrors body
    // bounds) needs to re-sync.
    this.fireRectChange();
  }

  /** Set the panel's height-lock preset. `"off"` releases the
   *  panel to free resize; the other three lock height to that
   *  fraction of the safe area between the top and bottom taskbar
   *  reserves (computed via `uiEditMode.reservedTop` /
   *  `reservedBottom`, falling back to the full viewport when no
   *  edit-mode reference is wired). Position is left alone — a
   *  `"full"` panel may overflow the safe area until the user
   *  drags it into place. */
  setHeightMode(mode: HeightMode): void {
    if (this._heightMode === mode) return;
    this._heightMode = mode;
    this.storageSet("heightMode", mode);
    // Locking the height makes vertical resize a no-op — flip the
    // user's raw toggle off too so the popup glyph reflects the
    // forced state (matches the snap → draggable interlock in
    // `setSnap`). The user re-enables Y resize after they unlock
    // the height; we don't auto-restore.
    if (mode !== "off" && this._resizableY) {
      this._resizableY = false;
      this.storageSet("resizableY", "0");
    }
    this.applyHeight();
    this.refreshChrome();
    // `applyHeight` rewrites `panel.style.height` but doesn't
    // notify rectChange subscribers, so a PixiPanel mirroring
    // the body region wouldn't re-sync until the next unrelated
    // event. Fire here so the Pixi content / mask track the
    // new height on the same tick as the popup click.
    this.fireRectChange();
    for (const cb of this.heightModeChangeListeners) cb(mode);
    // `effectiveResizeY` includes a `heightMode === "off"` gate,
    // so flipping height mode can also flip the derived
    // `isResizable` (corner enable). Notify resize subscribers
    // so the Pixi corner indicator follows.
    for (const cb of this.resizableChangeListeners) cb(this.isResizable);
  }

  /** Recompute and write the locked height when `heightMode` is
   *  active. No-op when `"off"` — the user owns the height. Called
   *  from the constructor, the setter, window resize, the resize
   *  gesture's `onMove` / `onEnd`, and from `setContentNaturalHeight`
   *  while in `"auto"` mode. Two paths:
   *
   *   - `"full"` / `"half"` / `"quarter"`: panel height = a fraction
   *     of the safe area (viewport between the wired `UiEditMode`
   *     reserves; falls back to the full viewport when no edit-mode
   *     manager is wired).
   *   - `"auto"`: panel height = title bar's current height +
   *     `_contentNaturalHeight`. Skipped silently when no content
   *     height has been reported yet — the panel keeps its prior
   *     height until the consumer pushes one. */
  private applyHeight(): void {
    if (this._heightMode === "off") return;
    if (this._heightMode === "auto") {
      if (this._contentNaturalHeight === null) return;
      // Title bar's current height — zero when `titleBarHidden` /
      // `display: none`. The body is `flex: 1 1 auto`, so once we
      // pin the outer panel height the body absorbs the difference
      // exactly.
      const titlebarH = this.titlebar.offsetHeight;
      const h = Math.max(this.minHeight, titlebarH + this._contentNaturalHeight);
      this.panel.style.height = `${h}px`;
      return;
    }
    const reservedTop    = this.uiEditMode?.reservedTop    ?? 0;
    const reservedBottom = this.uiEditMode?.reservedBottom ?? 0;
    const safe = Math.max(
      this.minHeight,
      window.innerHeight - reservedTop - reservedBottom,
    );
    const h = Math.max(
      this.minHeight,
      Math.round(safe * HEIGHT_FRACTIONS[this._heightMode]),
    );
    this.panel.style.height = `${h}px`;
  }

  /** Set the panel's snap preset. `"none"` releases position
   *  control back to the user; the four corners snap the panel
   *  to that corner of the safe area between the taskbar
   *  reserves and force `_draggable` off (the user can't drag a
   *  snapped panel — that's the whole point of snapping). The
   *  forced-off `_draggable` persists when snap returns to
   *  `"none"`; the user re-enables dragging via the popup's
   *  Draggable toggle. */
  setSnap(snap: SnapMode): void {
    if (this._snap === snap) return;
    this._snap = snap;
    this.storageSet("snap", snap);
    if (snap !== "none" && this._draggable) {
      this._draggable = false;
      this.storageSet("draggable", "0");
      for (const cb of this.draggableChangeListeners) cb(false);
    }
    this.applySnap();
    this.applyAnchor();
    this.refreshChrome();
    for (const cb of this.snapChangeListeners) cb(snap);
  }

  /** Flip the per-panel "drag enabled" toggle. While a non-none
   *  snap is active the snap-forces-drag-off rule wins, so this
   *  is a no-op — the popup also greys out the row's glyph to
   *  signal the lock. Users clear snap (via the Snap row) to
   *  regain control of this toggle. */
  toggleDraggable(): void {
    if (this._snap !== "none") return;
    this._draggable = !this._draggable;
    this.storageSet("draggable", this._draggable ? "1" : "0");
    this.refreshChrome();
    for (const cb of this.draggableChangeListeners) cb(this._draggable);
  }

  /** Reposition the panel to its snap corner of the safe area
   *  (viewport minus taskbar reserves). No-op when `_snap` is
   *  `"none"` or the panel isn't mounted yet (the open path and
   *  the window-resize handler call this again once the panel
   *  exists in the DOM). Preserves current size — width and
   *  height aren't touched. Anchor's CSS pinning is re-applied
   *  by the caller after this writes, so the two stay
   *  consistent. */
  private applySnap(): void {
    if (this._snap === "none") return;
    if (!this.panel.isConnected) return;
    const rect = this.panel.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const reservedTop    = this.uiEditMode?.reservedTop    ?? 0;
    const reservedBottom = this.uiEditMode?.reservedBottom ?? 0;
    let left: number;
    let top:  number;
    if (this._snap === "top-left") {
      left = 0;
      top  = reservedTop;
    } else if (this._snap === "top-right") {
      left = viewW - w;
      top  = reservedTop;
    } else if (this._snap === "bottom-left") {
      left = 0;
      top  = viewH - reservedBottom - h;
    } else {
      // bottom-right
      left = viewW - w;
      top  = viewH - reservedBottom - h;
    }
    this.panel.style.left   = `${left}px`;
    this.panel.style.top    = `${top}px`;
    this.panel.style.right  = "auto";
    this.panel.style.bottom = "auto";
  }

  /** Pull the panel back inside the safe area if any part of it
   *  is off-screen. Used by the window-resize handler (viewport
   *  shrinks can strand panels) and by `open` (persisted rect
   *  from a prior session might no longer fit). Skipped when
   *  snap is non-none — `applySnap` owns the position then.
   *
   *  Shrinks size first if the panel is too big for the safe
   *  area, then shifts position so the panel sits fully inside.
   *  Position writes use the anchor-matching CSS form so the
   *  pinned corner stays sticky after the call. */
  private clampToSafeArea(): void {
    if (this._snap !== "none") return;
    if (!this.panel.isConnected) return;
    // Skip transformed panels (e.g. FormOverlay's
    // `translate(-50%, -50%)` centering trick). Writing pixel
    // top/left here would land on top of `top: 50%; left: 50%`,
    // then the transform re-applies and shifts the panel by half
    // its own size on every clamp pass. The transform is a
    // signal that the developer owns positioning; respect it.
    if (this.panel.style.transform) return;
    const rect = this.panel.getBoundingClientRect();
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const reservedTop    = this.uiEditMode?.reservedTop    ?? 0;
    const reservedBottom = this.uiEditMode?.reservedBottom ?? 0;
    const safeBottom = viewH - reservedBottom;
    const safeH = Math.max(this.minHeight, safeBottom - reservedTop);
    const w = Math.max(this.minWidth, Math.min(rect.width,  viewW));
    // Don't shrink height when heightMode is locked — `applyHeight`
    // owns that dimension; clamping here would fight it. Width
    // shrinks regardless since width has no equivalent lock.
    const h = this._heightMode !== "off"
      ? rect.height
      : Math.max(this.minHeight, Math.min(rect.height, safeH));
    // Place top-left so panel sits inside the safe area. For
    // an over-tall panel (`min > max`), the inner `min` wins
    // via the outer `max` — top edge stays visible.
    const left = Math.max(0, Math.min(rect.left, viewW - w));
    const top  = Math.max(reservedTop, Math.min(rect.top, safeBottom - h));
    // Short-circuit when the computed rect matches the current
    // one — `open()` runs `clampToSafeArea` on every panel even
    // ones already inside the safe area, and we don't want to
    // rewrite CSS (clobbering e.g. percent-based positioning)
    // when nothing needs to move.
    const EPS = 0.5;
    if (
      Math.abs(w    - rect.width)  < EPS &&
      Math.abs(h    - rect.height) < EPS &&
      Math.abs(left - rect.left)   < EPS &&
      Math.abs(top  - rect.top)    < EPS
    ) return;
    if (w !== rect.width)  this.panel.style.width  = `${w}px`;
    if (h !== rect.height) this.panel.style.height = `${h}px`;
    if (this._anchor === "top-left") {
      this.panel.style.top    = `${top}px`;
      this.panel.style.left   = `${left}px`;
      this.panel.style.right  = "auto";
      this.panel.style.bottom = "auto";
    } else if (this._anchor === "top-right") {
      this.panel.style.top    = `${top}px`;
      this.panel.style.right  = `${viewW - (left + w)}px`;
      this.panel.style.left   = "auto";
      this.panel.style.bottom = "auto";
    } else if (this._anchor === "bottom-left") {
      this.panel.style.bottom = `${viewH - (top + h)}px`;
      this.panel.style.left   = `${left}px`;
      this.panel.style.right  = "auto";
      this.panel.style.top    = "auto";
    } else {
      // bottom-right
      this.panel.style.bottom = `${viewH - (top + h)}px`;
      this.panel.style.right  = `${viewW - (left + w)}px`;
      this.panel.style.left   = "auto";
      this.panel.style.top    = "auto";
    }
  }

  /** Content reports its natural height (the height it wants the
   *  body region to render at). Only consulted when `heightMode ===
   *  "auto"`; harmless to set otherwise. Pass `null` to clear the
   *  preference (the panel keeps its prior height until a new value
   *  arrives, or until the user switches to a non-auto mode). */
  setContentNaturalHeight(height: number | null): void {
    if (this._contentNaturalHeight === height) return;
    this._contentNaturalHeight = height;
    if (this._heightMode === "auto") {
      this.applyHeight();
      this.fireRectChange();
    }
  }

  /** Flip the per-panel "minimize enabled" toggle. Always
   *  applies — the old constructor cap was removed so the popup's
   *  toggle is meaningful for every panel. To suppress the popup
   *  row entirely, list `"minimize"` in the panel's
   *  `excludeSettings`. */
  toggleMinimizable(): void {
    this._minimizable = !this._minimizable;
    this.storageSet("minimizable", this._minimizable ? "1" : "0");
    this.refreshChrome();
    for (const cb of this.minimizableChangeListeners) cb(this._minimizable);
  }

  /** Flip the per-panel "hide minimize button" toggle. Independent
   *  from `toggleMinimizable` — this just gates the title-bar
   *  button's visibility; the underlying capability still lives
   *  on `_minimizable`. */
  toggleHideMinimizeBtn(): void {
    this._hideMinimizeBtn = !this._hideMinimizeBtn;
    this.storageSet("hideMinimizeBtn", this._hideMinimizeBtn ? "1" : "0");
    this.refreshChrome();
    for (const cb of this.hideMinimizeBtnChangeListeners) cb(this._hideMinimizeBtn);
  }

  /** Flip the per-panel "hide close button" toggle. Same shape as
   *  `toggleHideMinimizeBtn`. */
  toggleHideCloseBtn(): void {
    this._hideCloseBtn = !this._hideCloseBtn;
    this.storageSet("hideCloseBtn", this._hideCloseBtn ? "1" : "0");
    this.refreshChrome();
    for (const cb of this.hideCloseBtnChangeListeners) cb(this._hideCloseBtn);
  }

  /** Flip the per-panel "horizontal resize enabled" toggle.
   *  Effective right away — the X-edge handle hides / re-shows
   *  on the same tick. `onResizableChange` fires with the
   *  derived `isResizable` (corner enable) since that's the
   *  semantic external subscribers care about; subscribers that
   *  need the raw X flag read `isResizableX` from the panel. */
  toggleResizableX(): void {
    this._resizableX = !this._resizableX;
    this.storageSet("resizableX", this._resizableX ? "1" : "0");
    this.refreshChrome();
    for (const cb of this.resizableChangeListeners) cb(this.isResizable);
  }

  /** Flip the per-panel "vertical resize enabled" toggle. While
   *  `heightMode !== "off"` the height lock forces this off, so
   *  this is a no-op — the popup also greys out the row's glyph
   *  to signal the lock. Users switch height back to "off" to
   *  regain control of this toggle. */
  toggleResizableY(): void {
    if (this._heightMode !== "off") return;
    this._resizableY = !this._resizableY;
    this.storageSet("resizableY", this._resizableY ? "1" : "0");
    this.refreshChrome();
    for (const cb of this.resizableChangeListeners) cb(this.isResizable);
  }

  /** Effective vertical-resize enable — `_resizableY` AND the
   *  height isn't locked. A non-`"off"` heightMode pins the
   *  panel's height to a computed value, so a vertical drag
   *  handle would have nothing to do. */
  private effectiveResizeY(): boolean {
    return this._resizableY && this._heightMode === "off";
  }

  /** Flip the per-panel "close enabled" toggle. The Close button
   *  is always created; this only controls its visibility (along
   *  with the anchored-fixture rule in `refreshChrome`). */
  toggleClosable(): void {
    this._closable = !this._closable;
    this.storageSet("closable", this._closable ? "1" : "0");
    this.refreshChrome();
    for (const cb of this.closableChangeListeners) cb(this._closable);
  }

  /** Set the Pin preset. Unregisters from the previously-attached
   *  taskbar (if any) and registers with the new one (if the
   *  target edge has a live taskbar). No-op when `pin` matches
   *  the current value. Always re-registers when bars stay the
   *  same but the side flips (e.g. `"top-left"` → `"top-right"`)
   *  so the entry moves between the left / right groups. */
  setPin(pin: PinMode): void {
    if (this._pin === pin) return;
    const prevBar = this.currentTaskbar();
    this._pin = pin;
    this.storageSet("pin", pin);
    const nextBar = this.currentTaskbar();
    prevBar?.unregister(this);
    if (nextBar && !nextBar.destroyed) nextBar.register(this);
    for (const cb of this.pinChangeListeners) cb(pin);
  }

  /** Set the taskbar icon. `null` (or empty string) flips the
   *  entry to text mode (uses the panel title). Persists under
   *  `<storageKey>.taskbarIcon` — empty-string is the on-disk
   *  signal for "use text mode" so a fresh-load reader can tell
   *  the user's explicit clear from never-set. Fires
   *  `onTaskbarIconChange`; the live `PanelTaskbar` subscriber
   *  reshapes the entry button (icon-square ↔ wide text) in
   *  place. */
  setTaskbarIcon(icon: string | null): void {
    const normalised = icon === null || icon === "" ? null : icon;
    if (this._taskbarIcon === normalised) return;
    this._taskbarIcon = normalised;
    // Store empty string for the "explicitly cleared" case so a
    // null seed can still be overridden by a non-null persisted
    // value, and vice versa. The constructor restore mirrors this
    // encoding.
    this.storageSet("taskbarIcon", normalised ?? "");
    for (const cb of this.taskbarIconChangeListeners) cb(normalised);
  }

  /** Snapshot the panel's live state as a `PanelStateJSON`. Reads
   *  current in-memory fields (NOT localStorage — which may be
   *  stale or absent for never-persisted properties) so the result
   *  reflects exactly what the user sees right now. Position / size
   *  values come from the panel element's inline style (raw CSS
   *  strings: `"320px"`, `"auto"`, `"calc(…)"`). Output is shaped
   *  to be paste-ready under `content/panels/defaults.json`'s
   *  `panels.<defaultsKey>` entry. */
  serializeState(): PanelStateJSON {
    const s = this.panel.style;
    return {
      left:   s.left   || undefined,
      top:    s.top    || undefined,
      right:  s.right  || undefined,
      bottom: s.bottom || undefined,
      width:  s.width  || undefined,
      height: s.height || undefined,
      anchor:          this._anchor,
      snap:            this._snap,
      pin:             this._pin,
      heightMode:      this._heightMode,
      draggable:       this._draggable,
      minimizable:     this._minimizable,
      resizableX:      this._resizableX,
      resizableY:      this._resizableY,
      closable:        this._closable,
      hideMinimizeBtn: this._hideMinimizeBtn,
      hideCloseBtn:    this._hideCloseBtn,
      titleBarHidden:  this._titleBarHidden,
      gridSnap:        this._gridSnap,
      masked:          this._masked,
      minimized:       this._minimized,
    };
  }

  /** Wipe all per-panel persisted state and revert the panel to
   *  its constructor defaults: position/size to `defaultRect`,
   *  anchor to `"none"`, every toggle back to its constructor cap.
   *  Fires `onAnchorChange` so the taskbar / settings popup
   *  re-sync. Useful when the user has wedged a panel off-screen
   *  or just wants a clean slate. */
  resetToDefaults(): void {
    // Drop every persisted key for this panel. Hard-coded list so
    // it's obvious what reset touches — easier to audit than
    // matching a prefix and removing everything under it.
    const SUFFIXES = [
      "left", "top", "right", "bottom", "width", "height",
      "tab", "minimized",
      "anchor", "titleBarHidden", "gridSnap", "masked",
      "minimizable", "resizable", "resizableX", "resizableY",
      "closable", "hideMinimizeBtn", "hideCloseBtn",
      "pin", "heightMode",
      "snap", "draggable",
      "taskbarIcon", "titleSuffix",
    ];
    if (this.storageKey) {
      try {
        for (const suffix of SUFFIXES) {
          localStorage.removeItem(`${this.storageKey}.${suffix}`);
        }
      } catch { /* localStorage unavailable. */ }
    }

    // Restore runtime state to the "content defaults over
    // constructor seeds" stack — same precedence chain the
    // constructor uses, minus the localStorage layer (which we
    // just wiped). A field with no content override falls back to
    // the constructor seed (`initialMinimizable`, etc.). Reset's
    // intent is "back to the layout the content file describes,"
    // not "back to whatever the constructor hardcoded."
    const cd: PanelStateJSON = this.defaultsKey
      ? (DomPanel.panelDefaults?.[this.defaultsKey] ?? {})
      : {};
    this._anchor          = cd.anchor          ?? "top-left";
    this._titleBarHidden  = cd.titleBarHidden  ?? false;
    this._gridSnap        = cd.gridSnap        ?? false;
    const nextMasked      = cd.masked          ?? true;
    if (nextMasked !== this._masked) {
      this._masked = nextMasked;
      for (const cb of this.maskedChangeListeners) cb(this._masked);
    }
    this._minimizable     = cd.minimizable     ?? this.initialMinimizable;
    this._resizableX      = cd.resizableX      ?? this.initialResizable;
    this._resizableY      = cd.resizableY      ?? this.initialResizable;
    this._closable        = cd.closable        ?? this.initialClosable;
    this._hideMinimizeBtn = cd.hideMinimizeBtn ?? false;
    this._hideCloseBtn    = cd.hideCloseBtn    ?? false;
    this._heightMode      = cd.heightMode      ?? "off";
    this._snap            = cd.snap            ?? "none";
    this._draggable       = cd.draggable       ?? (this._snap === "none");
    this._taskbarIcon     = cd.taskbarIcon     ?? this.initialTaskbarIcon;
    this._titleSuffix     = cd.titleSuffix     ?? "none";
    this.setPin(cd.pin ?? this.initialPin);

    // Restore from minimize so the rolled-up height / hidden flag
    // don't carry across reset. Skip the change-listener fire if
    // we weren't actually minimized — `applyMinimized` early-
    // returns in that case anyway via its own dirty check at the
    // call site, but being explicit reads cleanly.
    if (this._minimized) this.applyMinimized(false);

    // Clear every CSS rect anchor so the only thing remaining is
    // what `defaultRect` explicitly sets. Without this, a panel
    // previously dragged would keep its `left`/`top` and the
    // default's `right`/`bottom` would fight it.
    this.panel.style.left   = "";
    this.panel.style.top    = "";
    this.panel.style.right  = "";
    this.panel.style.bottom = "";
    this.panel.style.width  = "";
    this.panel.style.height = "";
    this.applyRect(this.defaultRect);

    // Re-apply anchor (a no-op for `"none"`, but it still resets
    // the resize corner to its default `br` position) + refresh
    // chrome to flush button visibility for the new toggle state.
    this.applyAnchor();
    this.refreshChrome();
    for (const cb of this.anchorChangeListeners)     cb(this._anchor);
    for (const cb of this.heightModeChangeListeners) cb(this._heightMode);
    for (const cb of this.snapChangeListeners)       cb(this._snap);
    for (const cb of this.draggableChangeListeners)  cb(this._draggable);
    for (const cb of this.taskbarIconChangeListeners) cb(this._taskbarIcon);
    // Re-fire the title pair so taskbar / chrome / popup
    // re-sync after the reset's suffix-mode write above.
    // `setTitle` does the listener fan-out itself; the suffix
    // listeners need an explicit kick since we bypassed
    // `setTitleSuffix` to skip its persistence path (the
    // suffix key was already wiped by the SUFFIXES loop).
    this.setTitle(this.composeTitle());
    for (const cb of this.titleSuffixChangeListeners) cb(this._titleSuffix);
  }

  /** Open the shared per-panel settings popup bound to this
   *  panel. Triggered by the ⛯ button in edit mode; no-op if no
   *  UI-edit-mode manager is wired or the popup hasn't been
   *  attached to it yet. */
  openSettings(): void {
    this.uiEditMode?.openSettings(this);
  }

  /** Bump the panel one step up the stacking order. Useful when
   *  click-to-front isn't doing what you want (e.g. nudging a
   *  panel above a sibling without re-focusing). Clamped to the
   *  panel's band ceiling so a frantic clicker can't push a
   *  lower-band panel into a higher band's range. */
  layerUp(): void {
    const current = this.readZIndex();
    const max = Z_BAND_BASE[this._zBand] + Z_BAND_SIZE - 1;
    this.panel.style.zIndex = String(Math.min(max, current + 1));
  }

  /** Drop the panel one step down the stacking order. Floor at
   *  the band's base so the panel can't tuck behind a higher
   *  band's lowest z-index (or behind zero-z DOM). */
  layerDown(): void {
    const current = this.readZIndex();
    const min = Z_BAND_BASE[this._zBand];
    this.panel.style.zIndex = String(Math.max(min, current - 1));
  }

  /** Read the panel's current inline z-index as an integer, or
   *  fall back to the band's base when no inline value has been
   *  set yet — happens on the very first `layerUp`/`layerDown`
   *  call before `bringToFront` has assigned one. */
  private readZIndex(): number {
    const raw = parseInt(this.panel.style.zIndex, 10);
    return Number.isFinite(raw) ? raw : Z_BAND_BASE[this._zBand];
  }

  /** Re-evaluate every chrome surface that depends on edit-mode /
   *  lock / hide-title-bar / capability state. Runs once on
   *  construction (via the `uiEditMode.on` subscribe, or directly
   *  if there's no edit-mode reference) and on every state flip.
   *  Centralizing here keeps the rules in one place. */
  private refreshChrome(): void {
    // Title bar: visible when the constructor opted in AND the
    // user hasn't toggled it off. Edit mode no longer forces the
    // bar visible — the user can still open the settings popup
    // by clicking anywhere on the panel, so a panel with a
    // hidden title bar stays editable from its body.
    const titleBarVisible = this.titleBarAvailable && !this._titleBarHidden;
    this.titlebar.style.display = titleBarVisible ? "" : "none";

    // Minimize button visible iff BOTH the capability toggle says
    // so AND the user hasn't opted to hide just the button.
    // Capability vs button visibility are independent — a panel
    // can stay minimizable (e.g., via the taskbar entry) while the
    // chrome button is hidden for decluttering. Anchor no longer
    // hides either; that's purely a resize-corner preset now.
    this.minimizeBtn.style.display = this.isMinimizeBtnVisible ? "" : "none";
    // Close button — same shape.
    this.closeBtn.style.display = this.isCloseBtnVisible ? "" : "none";

    // Resize handles — each axis gates its own edge; the corner
    // requires both axes (and an unlocked height). Hidden while
    // minimized, gated by `applyMinimized` so this branch only
    // runs in the normal case.
    if (!this._minimized) {
      const xOn      = this._resizableX;
      const yOn      = this.effectiveResizeY();
      const cornerOn = xOn && yOn;
      this.resizeCorner.style.display = cornerOn ? "" : "none";
      this.resizeEdgeX.style.display  = xOn      ? "" : "none";
      this.resizeEdgeY.style.display  = yOn      ? "" : "none";
    }

    // Title-bar cursor reflects whether dragging is currently
    // available. The combined `_draggable` + snap gate goes
    // through `isDraggable`; when it's off the cursor flips to
    // default to telegraph that "move" won't do anything.
    this.titlebar.style.cursor = this.isDraggable ? "move" : "default";
  }

  private fireRectChange(): void {
    if (this.rectChangeListeners.size === 0) return;
    const rect = this.panel.getBoundingClientRect();
    for (const cb of this.rectChangeListeners) cb(rect);
  }

  // ── Persistence ─────────────────────────────────────────────────
  // All reads / writes guarded against `localStorage` being unavailable
  // (private-browsing contexts, etc.). On error we silently degrade to
  // "no persistence" — the panel still works, it just forgets state.

  private storageGet(suffix: string): string | null {
    if (!this.storageKey) return null;
    try { return localStorage.getItem(`${this.storageKey}.${suffix}`); }
    catch { return null; }
  }

  private storageSet(suffix: string, value: string): void {
    if (!this.storageKey) return;
    try { localStorage.setItem(`${this.storageKey}.${suffix}`, value); }
    catch { /* localStorage unavailable. */ }
  }

  /** Read a persisted boolean stored as `"1"` / `"0"`, falling
   *  back to `defaultValue` for missing / malformed entries. Used
   *  by the constructor field-init block — `defaultValue` carries
   *  the content-defaults-or-constructor-seed value, so
   *  localStorage layers on top of "constructor seed + content
   *  override." Returns `defaultValue` for panels without a
   *  storageKey (persistence opted out). */
  private defaultedBool(suffix: string, defaultValue: boolean): boolean {
    const raw = this.storageGet(suffix);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return defaultValue;
  }

  private restorePosition(): void {
    // Restore all four CSS anchors so anchored panels come back
    // to their pinned corner correctly. A free-floating panel
    // persists right / bottom as `"auto"`, so restoring those
    // also clears any leftover anchor values from the
    // constructor `defaultRect`.
    const left   = this.storageGet("left");
    const top    = this.storageGet("top");
    const right  = this.storageGet("right");
    const bottom = this.storageGet("bottom");
    if (left   !== null) this.panel.style.left   = left;
    if (top    !== null) this.panel.style.top    = top;
    if (right  !== null) this.panel.style.right  = right;
    if (bottom !== null) this.panel.style.bottom = bottom;
  }

  private restoreSize(): void {
    const w = this.storageGet("width");
    const h = this.storageGet("height");
    if (w) this.panel.style.width  = w;
    if (h) this.panel.style.height = h;
  }

  private persistPosition(): void {
    this.storageSet("left",   this.panel.style.left);
    this.storageSet("top",    this.panel.style.top);
    this.storageSet("right",  this.panel.style.right);
    this.storageSet("bottom", this.panel.style.bottom);
  }

  private persistSize(): void {
    this.storageSet("width",  this.panel.style.width);
    this.storageSet("height", this.panel.style.height);
  }

  private loadSavedTab(): string | null {
    return this.storageGet("tab");
  }

  private persistTab(): void {
    if (this._activeTabId !== null) this.storageSet("tab", this._activeTabId);
  }

  private loadSavedMinimized(): boolean {
    return this.storageGet("minimized") === "1";
  }

  private persistMinimized(): void {
    this.storageSet("minimized", this._minimized ? "1" : "0");
  }
}
