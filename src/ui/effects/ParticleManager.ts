import { Assets, ParticleContainer, Texture } from "pixi.js";
import { Emitter, upgradeConfig } from "@spd789562/particle-emitter";
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
  /** Position in the ParticleManager's local coordinate space. */
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
  emitter:   Emitter;
  container: ParticleContainer;
  /** maxParticles declared by the effect's JSON config. */
  desired:   number;
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
 *   const handle = pm.spawn("smoke", { x: 200, y: 100 });
 *   handle.stop();   // stops emission; particles drain naturally
 *   handle.destroy() // removes immediately
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
      entry.emitter.destroy();
      entry.container.destroy({ children: true });
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
   * Spawn a named particle effect.
   *
   * @param name  File name without path or extension
   *              (e.g. "smoke" → assets/effects/json/smoke.json)
   */
  spawn(name: string, opts: SpawnOptions = {}): ParticleHandle {
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

    const container = new ParticleContainer();
    container.position.set(opts.x ?? 0, opts.y ?? 0);
    this.addChild(container);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitter = new Emitter(container as any, v3config);
    if (opts.lifetime !== undefined) {
      emitter.emitterLifetime = opts.lifetime;
    }
    emitter.emit = true;

    const desired = (rawConfig.maxParticles as number | undefined) ?? 100;
    const entry: ActiveEntry = { emitter, container, desired };
    this._active.push(entry);
    this._rebalanceBudget();

    let destroyed = false;

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
        container.destroy({ children: true });
        cleanup();
      },
    };
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
        entry.emitter.destroy();
        entry.container.destroy({ children: true });
        this._active.splice(i, 1);
        reaped = true;
      }
    }

    if (reaped) this._rebalanceBudget();
  }

  /**
   * Distribute the global maxParticles budget across all active emitters
   * proportionally to each emitter's configured desired count.  When total
   * desired ≤ budget every emitter gets its full allocation unchanged.
   */
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
