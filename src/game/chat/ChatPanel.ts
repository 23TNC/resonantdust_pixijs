import type { GameContext } from "../../GameContext";
import type { ChatMessage } from "../../server/spacetime/bindings/types";
import { debug } from "../../debug";
import { DomPanel } from "../../ui/dom/DomPanel";

const PLACEHOLDER_TEXT = "Type a message…";

/** How close to the bottom the scroll has to be (in px) before we
 *  consider the user "anchored" and auto-scroll new messages into
 *  view. Anything further up means the user is reading scrollback;
 *  in that case we don't yank the viewport to the new message. */
const AUTO_SCROLL_EPSILON = 4;

/** Mirror of the server's `RETENTION_MS` in `chat.rs` (1 h). If our
 *  previous login was inside the retention window the server still
 *  has those rows — pick `last_login_secs` so we catch up on what
 *  we missed. Otherwise the rows are gone anyway and "since now"
 *  gives a tiny payload. */
const RETENTION_SECS = 60 * 60;

const PANEL_CSS_OVERRIDES: Partial<CSSStyleDeclaration> = {
  minWidth: "320px",
};

const TAB_CONTENT_CSS: Partial<CSSStyleDeclaration> = {
  flex: "1 1 auto",
  overflowY: "auto",
  overflowX: "hidden",
  padding: "6px 8px",
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  fontFamily: "sans-serif",
  fontSize: "13px",
  color: "#dddddd",
};

const MESSAGE_ROW_CSS: Partial<CSSStyleDeclaration> = {
  wordBreak: "break-word",
  lineHeight: "1.35",
};

const SENDER_CSS: Partial<CSSStyleDeclaration> = {
  color: "#ecd6aa",
  fontWeight: "600",
  marginRight: "4px",
};

const LOG_ROW_CSS: Partial<CSSStyleDeclaration> = {
  wordBreak: "break-word",
  lineHeight: "1.35",
  color: "#a0c0e0",
  fontStyle: "italic",
};

const FOOTER_CSS: Partial<CSSStyleDeclaration> = {
  padding: "6px 8px",
  borderTop: "1px solid #2a3340",
  background: "rgba(12, 14, 20, 0.96)",
};

const INPUT_CSS: Partial<CSSStyleDeclaration> = {
  width: "100%",
  boxSizing: "border-box",
  background: "#0e1318",
  color: "#ffffff",
  border: "1px solid #2a3340",
  borderRadius: "3px",
  outline: "none",
  fontFamily: "sans-serif",
  fontSize: "13px",
  padding: "4px 8px",
  margin: "0",
};

/**
 * Chat panel — pure DOM. Hosts two tabs ("general" / "logs") inside a
 * `DomPanel` shell, with a footer-anchored input for sending messages.
 *
 * The shell handles drag, resize, minimize/close, position + tab
 * persistence, and the chrome (title bar, action buttons). This class
 * is just data wiring:
 *   - subscribes to `ctx.data.chatMessages` for the general feed, with
 *     a retention-aware threshold based on `player.lastLoginSecs`
 *   - subscribes to `ctx.logs` for the client-only flavor-text feed
 *   - sends on `Enter` in the input field via
 *     `ctx.reducers.sendChatMessage`
 *
 * Per-message rendering is a single `<div>` appended to the active
 * tab's scroll container. Auto-scroll-to-bottom kicks in only when
 * the user is already pinned to the bottom — scrolling up to read
 * older messages keeps the viewport steady when new rows arrive.
 *
 * Lifecycle: the panel is owned by `GameScene`. `destroy()` tears
 * down all subscriptions and removes the DOM element.
 */
export class ChatPanel {
  private readonly panel: DomPanel;
  private readonly generalContent: HTMLDivElement;
  private readonly logsContent:    HTMLDivElement;
  private readonly inputEl:        HTMLInputElement;

  /** Map of chat row key → rendered DOM node. Lets us drop a single
   *  row on a `removed` event (retention sweep) without re-rendering
   *  the entire scrollback. */
  private readonly generalRows = new Map<bigint, HTMLDivElement>();

  private readonly unsubChat: () => void;
  private readonly unsubLogs: () => void;
  private readonly ctx: GameContext;

  get isOpen(): boolean { return this.panel.isOpen; }

  constructor(ctx: GameContext) {
    this.ctx = ctx;

    this.panel = new DomPanel({
      title: "Chat",
      storageKey: "chatPanel",
      // Bottom-anchored above the taskbar strip. `PanelTaskbar.HEIGHT`
      // is the source of truth; reading from the static keeps this
      // in lockstep if the bar's height ever changes.
      defaultRect: { left: "0", bottom: "32px", width: "360px", height: "260px" },
      minWidth:  280,
      minHeight: 160,
      taskbar: ctx.taskbar,
      pinned: true,
      uiEditMode: ctx.uiEditMode,
    });
    Object.assign(this.panel.panel.style, PANEL_CSS_OVERRIDES);

    this.generalContent = this.makeScrollContainer();
    this.logsContent    = this.makeScrollContainer();
    this.panel.addTab("general", "💬", this.generalContent);
    this.panel.addTab("logs",    "📜", this.logsContent);

    // Footer: one input shared across tabs. Native focus / caret /
    // IME come for free — no need for the canvas-overlay dance the
    // old Pixi chat used to do.
    const footer = document.createElement("div");
    Object.assign(footer.style, FOOTER_CSS);
    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.autocomplete = "off";
    this.inputEl.placeholder = PLACEHOLDER_TEXT;
    Object.assign(this.inputEl.style, INPUT_CSS);
    this.inputEl.addEventListener("keydown", (e) => this.onInputKeyDown(e));
    footer.appendChild(this.inputEl);
    this.panel.setFooter(footer);

    // ── Server subscription — chat feed ───────────────────────────
    // Same retention-window logic the Pixi chat used: pick
    // `lastLoginSecs` if it's still inside the server's retention
    // window so we catch up on what we missed; otherwise "since now"
    // for a tiny initial payload. After installing the subscription
    // bump `last_login_secs` so next session's threshold reflects
    // this one.
    const player = ctx.playerSession.getPlayer();
    const lastLoginSecs = player?.lastLoginSecs ?? 0;
    const nowSecs = Math.floor(ctx.reducers.serverNowMs() / 1_000);
    const thresholdSecs =
      lastLoginSecs > nowSecs - RETENTION_SECS ? lastLoginSecs : nowSecs;
    // `sent_at` is the packed `(time_ms << 16) | seq` u64.
    const thresholdPacked = (BigInt(thresholdSecs) * 1_000n) << 16n;
    debug.log(
      ["chat"],
      `[ChatPanel] subscribing to chat: lastLogin=${lastLoginSecs}s now=${nowSecs}s → threshold=${thresholdSecs}s (packed=${thresholdPacked})`,
    );
    void ctx.data.chatSubscriptions.subscribeChat(thresholdPacked);
    void ctx.reducers.setLastLogin();

    // Seed initial render: any rows that already arrived before we
    // subscribed get pushed in one pass.
    for (const row of ctx.data.chatMessages.sorted()) {
      this.appendChatRow(this.keyForChat(row), row, /* autoScroll */ false);
    }
    this.scrollToBottom(this.generalContent);

    this.unsubChat = ctx.data.chatMessages.subscribe((change) => {
      if (change.kind === "added") {
        this.appendChatRow(change.key, change.row, /* autoScroll */ true);
      } else {
        const node = this.generalRows.get(change.key);
        if (node) {
          node.remove();
          this.generalRows.delete(change.key);
        }
      }
    });

    // ── Client-only logs feed ─────────────────────────────────────
    // `ctx.logs` is a `LogManager` (push-only, no retention sweep);
    // we render the buffer on every push.
    if (ctx.logs) {
      this.renderLogs();
      this.unsubLogs = ctx.logs.subscribe(() => this.renderLogs());
    } else {
      this.unsubLogs = () => { /* no logs source — no-op */ };
    }
  }

  open():    void { this.panel.open();    }
  close():   void { this.panel.close();   }
  toggle():  void { this.panel.toggle();  }

  destroy(): void {
    this.unsubChat();
    this.unsubLogs();
    this.ctx.data.chatSubscriptions.unsubscribeChat();
    this.panel.destroy();
  }

  // ── Internals ────────────────────────────────────────────────────

  private makeScrollContainer(): HTMLDivElement {
    const div = document.createElement("div");
    Object.assign(div.style, TAB_CONTENT_CSS);
    return div;
  }

  private onInputKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      const body = this.inputEl.value.trim();
      if (body.length > 0) {
        debug.log(["chat"], `[ChatPanel] sending message len=${body.length}`);
        const player = this.ctx.playerSession.getPlayer();
        if (player) {
          void this.ctx.reducers.sendChatMessage({
            senderPlayerId: player.playerId,
            senderName: player.name,
            body,
          });
        }
      }
      this.inputEl.value = "";
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.inputEl.blur();
    }
    e.stopPropagation();
  }

  /** Append a chat row's `<div>` to the general tab. When
   *  `autoScroll` is true and the user was pinned to the bottom
   *  before the append, we scroll the new row into view. Otherwise
   *  the viewport stays where the user parked it (reading scroll-
   *  back). */
  private appendChatRow(key: bigint, row: ChatMessage, autoScroll: boolean): void {
    if (this.generalRows.has(key)) return;
    const pinned = autoScroll && this.isPinnedToBottom(this.generalContent);
    const node = document.createElement("div");
    Object.assign(node.style, MESSAGE_ROW_CSS);
    const sender = document.createElement("span");
    Object.assign(sender.style, SENDER_CSS);
    sender.textContent = `${row.senderName}:`;
    const body = document.createElement("span");
    body.textContent = ` ${row.body}`;
    node.appendChild(sender);
    node.appendChild(body);
    this.generalContent.appendChild(node);
    this.generalRows.set(key, node);
    if (pinned) this.scrollToBottom(this.generalContent);
  }

  /** Full re-render of the logs tab — the buffer is push-only and
   *  short (game-event blurbs), so re-rendering is cheaper than the
   *  bookkeeping needed for incremental appends. */
  private renderLogs(): void {
    const log = this.ctx.logs;
    if (!log) return;
    const pinned = this.isPinnedToBottom(this.logsContent);
    while (this.logsContent.firstChild) {
      this.logsContent.removeChild(this.logsContent.firstChild);
    }
    for (const entry of log.getAll()) {
      const node = document.createElement("div");
      Object.assign(node.style, LOG_ROW_CSS);
      node.textContent = entry.text;
      this.logsContent.appendChild(node);
    }
    if (pinned) this.scrollToBottom(this.logsContent);
  }

  private isPinnedToBottom(el: HTMLDivElement): boolean {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distance <= AUTO_SCROLL_EPSILON;
  }

  private scrollToBottom(el: HTMLDivElement): void {
    el.scrollTop = el.scrollHeight;
  }

  /** Synthesize the AppendTable key for a chat row. The table keys
   *  rows by `sent_at` (the packed u64); the seed pass uses this
   *  to dedupe against the subscribe callback's `change.key`. */
  private keyForChat(row: ChatMessage): bigint {
    return row.sentAt;
  }
}
