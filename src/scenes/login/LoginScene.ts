import type { GameContext } from "../../GameContext";
import { CharacterSelectScene } from "../select/CharacterSelectScene";
import { Scene } from "../Scene";
import { FormOverlay } from "./FormOverlay";
import { TitleBar } from "../../game/titlebar/TitleBar";

type Mode = "login" | "create";

/** Wire Enter on an input to a callback. Standard form-submit
 *  affordance — pressing Enter from any field fires the primary
 *  action (Login or Create depending on mode). Calls
 *  `preventDefault` so the browser doesn't try a real form submit
 *  (we don't wrap in a `<form>`, but some browsers still ping the
 *  enclosing context). */
function attachEnterHandler(input: HTMLInputElement, onSubmit: () => void): void {
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    onSubmit();
  });
}

/**
 * Trust-on-first-use login / create-user form. Server-side
 * `claim_or_login` already does both — if the username is unused
 * it creates a player, else it logs in — so "Create" and "Login"
 * hit the same reducer. The mode toggle is purely a UX affordance
 * (intent + the password-match validation that gates the call).
 *
 * Password fields render but their values are NOT sent to the
 * server yet. The repeat-password check on the create path is the
 * only thing they're wired into; both behave as decorative until a
 * server auth path lands.
 *
 * The form lives in a DOM overlay (`FormOverlay`) parented to the
 * canvas host. Pixi-native form input could replace it later by
 * swapping this scene's body — no other module touches the
 * overlay.
 */
export class LoginScene extends Scene {
  private overlay = new FormOverlay();
  private mode: Mode = "login";
  private busy = false;
  /** Username carried across mode switches and a successful create
   *  → back-to-login transition, so the user doesn't retype. */
  // Dev-time prefill: skips having to type a name every reload.
  // Drop the default to `""` when shipping to real users — TODO
  // gate this on `import.meta.env.DEV` once we have a release
  // build to differentiate.
  private rememberedUsername = "Player1";
  private titleBar!: TitleBar;
  private ctxRef: GameContext | null = null;

  onEnter(ctx: GameContext): void {
    this.ctxRef = ctx;
    this.titleBar = new TitleBar("");
    this.root.addChild(this.titleBar.container);

    this.overlay.mount();
    // Center the form in the space below the title bar. The panel uses
    // `top: 50%; transform: translate(-50%, -50%)` to center itself in
    // the host element — shifting top by half the bar height moves the
    // center point down into the remaining content area.
    this.overlay.panel.style.top = `calc(50% + ${TitleBar.HEIGHT / 2}px)`;

    this.render(ctx);

    // Apply initial bounds so the TitleBar draws on the first frame
    // before SceneManager fires onResize (which runs after onEnter).
    this.titleBar.setBounds(0, 0, this.width || window.innerWidth, TitleBar.HEIGHT);
    this.titleBar.layoutIfDirty();
  }

  onExit(): void {
    this.ctxRef = null;
    this.titleBar.destroy();
    this.overlay.unmount();
  }

  onResize(width: number, _height: number): void {
    this.titleBar.setBounds(0, 0, width, TitleBar.HEIGHT);
    this.titleBar.layoutIfDirty();
  }

  update(deltaMS: number): void {
    const drawCalls = this.ctxRef?.drawCallCounter.readAndReset() ?? 0;
    this.titleBar.updateStats(deltaMS, drawCalls);
    this.titleBar.layoutIfDirty();
  }

  private render(ctx: GameContext): void {
    this.overlay.clear();

    const usernameInput = this.overlay.addInput("Username", "text", this.rememberedUsername);
    const passwordInput = this.overlay.addInput("Password", "password");

    // Primary action — what Enter triggers from any input. Mode
    // picks the verb (Login or Create); the same handler the
    // corresponding button uses. Defined once so the keydown
    // handlers below can reuse it without re-reading mode at fire
    // time (mode is mutable across renders, but each render binds
    // a fresh primary closure).
    let primary: () => void;
    if (this.mode === "create") {
      const repeatInput = this.overlay.addInput("Repeat password", "password");
      primary = () => this.doCreate(
        ctx,
        usernameInput.value.trim(),
        passwordInput.value,
        repeatInput.value,
      );
      this.overlay.addButton("Create", primary);
      this.overlay.addButton("Back", () => this.switchMode("login", usernameInput.value.trim(), ctx));
      // Enter from any of the three inputs fires Create.
      attachEnterHandler(repeatInput, primary);
    } else {
      primary = () => this.doLogin(ctx, usernameInput.value.trim());
      this.overlay.addButton("Login", primary);
      this.overlay.addButton("Create user", () => this.switchMode("create", usernameInput.value.trim(), ctx));
    }
    attachEnterHandler(usernameInput, primary);
    attachEnterHandler(passwordInput, primary);

    this.overlay.attachStatus();
    this.overlay.setStatus(this.mode === "create"
      ? "Pick a username. Password fields are decorative for now."
      : "Enter a username to log in (passwords aren't checked yet).");

    // Auto-focus the first empty input. Helpful on entry and after
    // a mode swap — keeps keyboard flow without a mouse trip.
    if (usernameInput.value === "") usernameInput.focus();
    else passwordInput.focus();
  }

  private switchMode(next: Mode, currentUsername: string, ctx: GameContext): void {
    if (this.busy) return;
    this.rememberedUsername = currentUsername;
    this.mode = next;
    this.render(ctx);
  }

  private async doLogin(ctx: GameContext, username: string): Promise<void> {
    if (this.busy) return;
    if (username === "") {
      this.overlay.setStatus("Username is required.", "error");
      return;
    }
    this.busy = true;
    this.overlay.setStatus(`Logging in as ${username}…`);
    try {
      await ctx.playerSession.claimOrLogin(username);
      // SceneManager.change is fire-and-forget here — once it
      // succeeds, this scene's `onExit` will unmount the overlay.
      ctx.scenes.change(new CharacterSelectScene()).catch((err) => {
        console.error("[LoginScene] scene change failed", err);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.overlay.setStatus(`Login failed: ${message}`, "error");
      console.error("[LoginScene] login failed", err);
      this.busy = false;
    }
  }

  private async doCreate(
    ctx: GameContext,
    username: string,
    password: string,
    repeat: string,
  ): Promise<void> {
    if (this.busy) return;
    if (username === "") {
      this.overlay.setStatus("Username is required.", "error");
      return;
    }
    // Password match check is the only thing wired to the password
    // fields today. When server auth lands we'll send the password
    // along with the reducer call — for now the check is purely a
    // UX gate confirming the user typed what they meant.
    if (password !== repeat) {
      this.overlay.setStatus("Passwords don't match.", "error");
      return;
    }
    this.busy = true;
    this.overlay.setStatus(`Creating user ${username}…`);
    try {
      // `claim_or_login` is trust-on-first-use: an unused username
      // creates the player, an existing username logs in. From the
      // user's perspective hitting "Create" with an existing
      // username will silently log them in — acceptable v1 since
      // the username-already-exists check isn't gated server-side
      // yet. Once a real `create_user` reducer lands we'd call
      // that here and surface a clearer error.
      await ctx.playerSession.claimOrLogin(username);
      // Disconnect immediately so the next claimOrLogin (from the
      // Login button) re-establishes the session — keeps the "log
      // out then back in" narrative honest. If reconnecting feels
      // jarring we can skip straight to GameScene instead.
      this.rememberedUsername = username;
      this.mode = "login";
      this.busy = false;
      this.render(ctx);
      this.overlay.setStatus(`User ${username} ready. Log in to continue.`, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.overlay.setStatus(`Create failed: ${message}`, "error");
      console.error("[LoginScene] create failed", err);
      this.busy = false;
    }
  }
}
