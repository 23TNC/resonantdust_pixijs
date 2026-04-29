import { Assets, ParticleContainer, Texture } from "pixi.js";
import { type EmitterConfigV3, Emitter, upgradeConfig } from "@spd789562/particle-emitter";
import { LayoutObject, type LayoutObjectOptions } from "@/ui/layout/LayoutObject";

// Eagerly load all effect JSON configs from the effects folder.
// Any new .json file added to assets/effects/json/ is picked up automatically
// without changing this file.
const _rawConfigs = import.meta.glob(
  "../../assets/effects/json/*.json",
  { eager: true, import: "default" },
) as Record<string, Record<string, unknown>>;

const _configByName = new Map<string, Record<string, unknown>>();
for (const [path, cfg] of Object.entries(_rawConfigs)) {
  _configByName.set(path.replace(/^.*\/([^/]+)\.json$/, "$1"), cfg);
}

// Vite resolves this to a stable hashed URL in production builds.
const DEFAULT_TEXTURE_URL = new URL(
  "../../assets/effects/images/Pixel25px.png",
  import.meta.url,
).href;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SpawnOptions {
  /** Position in the ParticleManager's local coordinate space (spawn() only). */
  x?: number;
  y?: number;
  /**
   * Override `emitterLifetime` from the JSON config (seconds).
   * Pass -1 for an infinite loop; omit to use the config value.
   */
  lifetime?: number;
  /**
   * Textures for the particles.  Defaults to the built-in pixel texture
   * (loaded by init()) or Texture.WHITE if init() hasn't resolved yet.
   */
  textures?: Texture[];
  /** Override the start color of the color behavior (6-digit hex, with or without #). */
  startColor?: string;
  /** Override the end color of the color behavior (6-digit hex, with or without #). */
  endColor?: string;
}

export interface ParticleHandle {
  /** Move the effect origin each frame (e.g. to follow a card). */
  setPosition(x: number, y: number): void;
  /** Stop emitting; existing particles finish their natural lifetimes. */
  stop(): void;
  /** Remove the effect immediately regardless of remaining lifetime. */
  destroy(): void;
  /** True once the emitter has stopped and all its particles have expired. */
  readonly done: boolean;
}

export interface ParticleManagerOptions extends LayoutObjectOptions {
  /**
   * Hard cap on total live particles across all active effects.
   * When the sum of all emitters' desired particle counts exceeds this,
   * each emitter's allocation is scaled down proportionally.
   * Default: 500.
   */
  maxParticles?: number;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

interface ActiveEntry {
  emitter:       Emitter;
  container:     ParticleContainer;
  desired:       number;
  /** When false the container is owned externally; tick() and destroy() skip destroying it. */
  ownsContainer: boolean;
  /** Set by _createHandle so tick/destroy can mark the handle done when they reap the entry. */
  onReap?:       () => void;
}

// ─── ParticleManager ──────────────────────────────────────────────────────────

/**
 * Manages a pool of particle effects, enforcing a global particle budget.
 *
 * Usage:
 *   const pm = new ParticleManager({ maxParticles: 400 });
 *   await pm.init();                                  // load default texture
 *   app.ticker.add(e => pm.tick(e.deltaMS));          // wire up the ticker
 *   scene.addLayoutChild(pm);
 *
 *   // Overlay effect — ParticleManager owns the container:
 *   const handle = pm.spawn("smoke", { x: 200, y: 100 });
 *
 *   // Card-attached effect — caller owns the container:
 *   const handle = pm.createEmitter(card.particleContainer, "smoke");
 */
export class ParticleManager extends LayoutObject {
  private static _instance: ParticleManager | null = null;
  static getInstance(): ParticleManager | null { return ParticleManager._instance; }

  private _maxParticles:   number;
  private _active:         ActiveEntry[] = [];
  private _defaultTexture: Texture | null = null;
  private _initPromise:    Promise<void> | null = null;

  constructor(options: ParticleManagerOptions = {}) {
    super(options);
    ParticleManager._instance = this;
    this._maxParticles = options.maxParticles ?? 500;
  }

  override destroy(options?: Parameters<LayoutObject["destroy"]>[0]): void {
    if (ParticleManager._instance === this) ParticleManager._instance = null;
    for (const entry of this._active) {
      entry.onReap?.();
      entry.emitter.destroy();
      if (entry.ownsContainer) entry.container.destroy({ children: true });
    }
    this._active = [];
    super.destroy(options);
  }

  /**
   * Load the default particle texture.  Await once at startup before spawning
   * effects.  spawn() will fall back to Texture.WHITE if called earlier.
   */
  async init(): Promise<void> {
    if (this._initPromise) return this._initPromise;
    this._initPromise = Assets.load<Texture>(DEFAULT_TEXTURE_URL).then(tex => {
      this._defaultTexture = tex;
    });
    return this._initPromise;
  }

  /** Total live-particle budget across all active effects. */
  get maxParticles(): number { return this._maxParticles; }
  set maxParticles(value: number) {
    this._maxParticles = Math.max(1, value);
    this._rebalanceBudget();
  }

  /**
   * Spawn a named effect into the ParticleManager's own overlay container.
   * ParticleManager owns the ParticleContainer and destroys it when done.
   */
  spawn(name: string, opts: SpawnOptions = {}): ParticleHandle {
    const { v3config, rawConfig } = this._prepareConfig(name, opts);
    const container = new ParticleContainer();
    container.position.set(opts.x ?? 0, opts.y ?? 0);
    this.addChild(container);
    return this._createHandle(rawConfig, v3config, container, true, opts.lifetime);
  }

  /**
   * Create an emitter against an externally-owned ParticleContainer (e.g. one
   * that is a direct child of a Card).  ParticleManager tracks the emitter for
   * budget purposes but never destroys the container — the caller is responsible.
   */
  createEmitter(
    container: ParticleContainer,
    name:      string,
    opts:      Omit<SpawnOptions, "x" | "y"> = {},
  ): ParticleHandle {
    const { v3config, rawConfig } = this._prepareConfig(name, opts);
    return this._createHandle(rawConfig, v3config, container, false, opts.lifetime);
  }

  /**
   * Advance all active emitters and reap finished ones.
   * Wire up to the application ticker:
   *   app.ticker.add(elapsed => particleManager.tick(elapsed.deltaMS));
   */
  tick(deltaMS: number): void {
    if (this._active.length === 0) return;

    const deltaS = deltaMS / 1000;
    let reaped = false;

    for (let i = this._active.length - 1; i >= 0; i--) {
      const entry = this._active[i];
      entry.emitter.update(deltaS);

      if (!entry.emitter.emit && entry.emitter.particleCount === 0) {
        entry.onReap?.();
        entry.emitter.destroy();
        if (entry.ownsContainer) entry.container.destroy({ children: true });
        this._active.splice(i, 1);
        reaped = true;
      }
    }

    if (reaped) this._rebalanceBudget();
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _prepareConfig(
    name: string,
    opts: Omit<SpawnOptions, "x" | "y">,
  ): { v3config: EmitterConfigV3; rawConfig: Record<string, unknown> } {
    const rawConfig = _configByName.get(name);
    if (!rawConfig) {
      throw new Error(
        `ParticleManager: effect "${name}" not found — add ${name}.json to assets/effects/json/`,
      );
    }
    const textures = opts.textures
      ?? (this._defaultTexture ? [this._defaultTexture] : [Texture.WHITE]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v3config = upgradeConfig(rawConfig as any, textures);
    this._patchColors(v3config, opts);
    return { v3config, rawConfig };
  }

  private _patchColors(
    v3config: EmitterConfigV3,
    opts:     { startColor?: string; endColor?: string },
  ): void {
    if (opts.startColor === undefined && opts.endColor === undefined) return;
    for (const behavior of v3config.behaviors) {
      if (behavior.type === "color") {
        const list = (behavior.config.color?.list ?? []) as Array<{ value: string; time: number }>;
        behavior.config = {
          ...behavior.config,
          color: {
            ...behavior.config.color,
            list: list.map((step: { value: string; time: number }) => {
              if (step.time === 0 && opts.startColor !== undefined)
                return { ...step, value: opts.startColor.replace(/^#/, "") };
              if (step.time === 1 && opts.endColor !== undefined)
                return { ...step, value: opts.endColor.replace(/^#/, "") };
              return step;
            }),
          },
        };
        return;
      }
      if (behavior.type === "colorStatic" && opts.startColor !== undefined) {
        behavior.config = { ...behavior.config, color: opts.startColor.replace(/^#/, "") };
        return;
      }
    }
  }

  private _createHandle(
    rawConfig:     Record<string, unknown>,
    v3config:      EmitterConfigV3,
    container:     ParticleContainer,
    ownsContainer: boolean,
    lifetime?:     number,
  ): ParticleHandle {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitter = new Emitter(container as any, v3config);
    if (lifetime !== undefined) emitter.emitterLifetime = lifetime;
    emitter.emit = true;

    const desired = (rawConfig.maxParticles as number | undefined) ?? 100;
    const entry: ActiveEntry = { emitter, container, desired, ownsContainer };
    this._active.push(entry);
    this._rebalanceBudget();

    let destroyed = false;
    entry.onReap = () => { destroyed = true; };

    const cleanup = (): void => {
      const idx = this._active.indexOf(entry);
      if (idx >= 0) this._active.splice(idx, 1);
      this._rebalanceBudget();
    };

    return {
      get done(): boolean { return destroyed; },

      setPosition(x: number, y: number): void {
        if (!destroyed) container.position.set(x, y);
      },

      stop(): void {
        if (!destroyed) emitter.emit = false;
      },

      destroy(): void {
        if (destroyed) return;
        destroyed = true;
        emitter.destroy();
        if (ownsContainer) container.destroy({ children: true });
        cleanup();
      },
    };
  }

  private _rebalanceBudget(): void {
    if (this._active.length === 0) return;

    const totalDesired = this._active.reduce((s, e) => s + e.desired, 0);
    const underBudget  = totalDesired <= this._maxParticles;

    for (const entry of this._active) {
      entry.emitter.maxParticles = underBudget
        ? entry.desired
        : Math.max(1, Math.floor(this._maxParticles * (entry.desired / totalDesired)));
    }
  }
}
