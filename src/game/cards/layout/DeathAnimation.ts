import { Container, Graphics, ParticleContainer } from "pixi.js";
import { ParticleManager, type ParticleHandle } from "../../../assets/ParticleManager";

/** Per-frame mask-wipe step. `0..1` shrinks the mask top-to-bottom;
 *  `1..4` continues with the wipe complete so the ascend-particle
 *  tail plays out before the host splices and writes `dead: 2`. The
 *  4-second hex/rect cadence is the same so chains die in unison. */
const DEATH_SPEED = 0.04;

export interface DeathAnimationOptions {
  /** Card-local pixel width — `RECT_CARD_WIDTH` for rect cards,
   *  `HEX_CARD_WIDTH` for hex cards. Used to size the mask + position
   *  the particle emitter. */
  width: number;
  height: number;
  /** Display container that the mask wipes. The animation sets
   *  `target.mask = mask` when it starts and clears it (+ flips
   *  `visible = false`) once the wipe completes. Caller is
   *  responsible for parenting `mask` itself into the scene graph
   *  alongside `target` — Pixi requires masks to be in the display
   *  tree to render. */
  target: Container;
  /** Container the particle emitter parents under. Should sit
   *  *outside* the masked region so the ascending particles aren't
   *  clipped by the wipe — typically the outermost card container. */
  particleHost: Container;
}

/**
 * Mask-wipe + ascend-particle death animation for a single card.
 * Shared between `LayoutRectCard` and `LayoutHexCard`; differs only
 * in the bounding-box dimensions passed via `DeathAnimationOptions`.
 *
 * Lifecycle:
 *   1. Host adds `mask` to its scene graph once at construction.
 *   2. When the server's `FLAG_ACTION_DEAD` lands on the row (and
 *      `slot_hold` is clear), the host calls `start(color)`.
 *   3. The host's `layout()` calls `tick()` every frame while
 *      `isRunning` — return value `true` means "still animating,
 *      keep invalidating"; `false` on the frame the animation
 *      completes (host then runs splice + writes `dead: 2`).
 *
 * The mask itself stays parented to the host across the animation
 * — its geometry just clears at completion. Particles are torn down
 * via `destroyParticles()` from the inside.
 */
export class DeathAnimation {
  /** The wipe mask. Host adds this to its scene graph once
   *  (`container.addChild(deathAnimation.mask)`); the animation
   *  draws into it each frame. */
  readonly mask = new Graphics();

  private progress = 0;
  private running = false;
  private particleContainer: ParticleContainer | null = null;
  private particleHandle: ParticleHandle | null = null;

  constructor(private readonly options: DeathAnimationOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Start the death animation. Caller passes the particle color
   *  (typically `def.style[0]`). Idempotent — calling while already
   *  running is a no-op so a re-triggered `dead === 1` doesn't
   *  restart the wipe. */
  start(particleColor: string): void {
    if (this.running) return;
    this.running = true;
    this.progress = 0;
    this.options.target.mask = this.mask;
    this.spawnParticles(particleColor);
  }

  /** Advance one frame. Returns `true` while the animation has more
   *  to do; returns `false` on the frame it completes (host should
   *  then run its post-splice + `dead: 2` write). Also returns
   *  `false` when called while not running.
   *
   *  Two phases:
   *   - `progress < 1` — mask shrinks bottom-up; particle emitter
   *     follows the wipe edge.
   *   - `progress >= 1` — mask clears + target hidden + emitter
   *     stopped; tail plays out until `progress >= 4`. */
  tick(): boolean {
    if (!this.running) return false;
    this.progress += DEATH_SPEED;
    const { width, height, target } = this.options;
    const maskH = Math.max(0, (1 - this.progress) * height);
    this.mask.clear().rect(0, 0, width, maskH).fill(0xffffff);
    this.particleHandle?.setPosition(width / 2, maskH);

    if (this.progress >= 1 && target.visible) {
      target.visible = false;
      target.mask = null;
      this.mask.clear();
      this.particleHandle?.stop();
    }

    if (this.progress >= 4) {
      this.running = false;
      this.destroyParticles();
      return false;
    }
    return true;
  }

  destroy(): void {
    this.running = false;
    this.destroyParticles();
    this.mask.destroy();
  }

  private spawnParticles(color: string): void {
    const pm = ParticleManager.getInstance();
    if (!pm) return;
    const pc = new ParticleContainer();
    pc.position.set(this.options.width / 2, this.options.height);
    this.options.particleHost.addChild(pc);
    this.particleContainer = pc;
    this.particleHandle = pm.createEmitter(pc, "ascend", { startColor: color });
  }

  private destroyParticles(): void {
    this.particleHandle?.destroy();
    this.particleHandle = null;
    if (this.particleContainer) {
      this.options.particleHost.removeChild(this.particleContainer);
      this.particleContainer.destroy({ children: true });
      this.particleContainer = null;
    }
  }
}
