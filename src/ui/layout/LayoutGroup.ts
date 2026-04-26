import { Point } from "pixi.js";
import {
  LayoutRect,
  type LayoutPadding,
  type LayoutRectOptions,
} from "./LayoutRect";

export type LayoutDirection = "row" | "column";

export interface LayoutGroupOptions extends LayoutRectOptions {
  direction: LayoutDirection;
  gap?: number;
}

export interface LayoutChildOptions {
  weight?: number;
  fixedSize?: number;
  minSize?: number;
  maxSize?: number;
}

interface LayoutChildConfig {
  weight: number;
  fixedSize: number | null;
  minSize: number;
  maxSize: number | null;
}

interface LayoutChildRange {
  child: LayoutRect;
  start: number;
  end: number;
}

export class LayoutGroup extends LayoutRect {
  public direction: LayoutDirection;

  private gap: number;
  private childConfigs = new Map<LayoutRect, LayoutChildConfig>();
  private childRanges: LayoutChildRange[] = [];

  public constructor(options: LayoutGroupOptions) {
    super(options);

    this.direction = options.direction;
    this.gap = Math.max(0, options.gap ?? 0);
  }

  public addLayoutItem<T extends LayoutRect>(
    child: T,
    options: LayoutChildOptions = {},
  ): T {
    this.childConfigs.set(child, this.createChildConfig(options));
    return this.addLayoutChild(child);
  }

  public removeLayoutItem<T extends LayoutRect>(child: T): T {
    this.childConfigs.delete(child);
    this.childRanges = this.childRanges.filter((range) => range.child !== child);
    return this.removeLayoutChild(child);
  }

  public destroyLayoutItem(child: LayoutRect): void {
    this.removeLayoutItem(child);
    child.destroy({ children: true });
  }

  public setChildLayoutOptions(
    child: LayoutRect,
    options: LayoutChildOptions,
  ): void {
    if (!this.childConfigs.has(child)) {
      return;
    }

    this.childConfigs.set(child, this.createChildConfig(options));
    this.invalidateLayout();
  }

  public setDirection(direction: LayoutDirection): void {
    this.direction = direction;
    this.invalidateLayout();
  }

  public setGap(gap: number): void {
    this.gap = Math.max(0, gap);
    this.invalidateLayout();
  }

  public getGap(): number {
    return this.gap;
  }

  public override hitTestLayout(globalX: number, globalY: number): LayoutRect | null {
    const local = this.toLocal(new Point(globalX, globalY));

    if (!this.innerRect.contains(local.x, local.y)) {
      return null;
    }

    const main = this.direction === "row" ? local.x : local.y;
    const child = this.findChildAtMainAxis(main);

    return child?.hitTestLayout(globalX, globalY) ?? this;
  }

  protected override layoutChildren(): void {
    const children = this.getLayoutChildren().filter((child) => child.visible);
    this.childRanges = [];

    if (children.length === 0) {
      return;
    }

    const metrics = this.getLayoutMetrics(children.length);

    let fixedTotal = 0;
    let totalWeight = 0;

    for (const child of children) {
      const config = this.getChildConfig(child);

      if (config.fixedSize !== null) {
        fixedTotal += this.clampSize(config.fixedSize, config);
      } else {
        totalWeight += Math.max(0, config.weight);
      }
    }

    const weightedSize = Math.max(0, metrics.availableMainSize - fixedTotal);
    let cursor = metrics.mainStart;

    for (const child of children) {
      const config = this.getChildConfig(child);
      const childMainSize = this.getChildMainSize(config, weightedSize, totalWeight);

      this.setChildLayout(child, cursor, childMainSize, metrics);

      this.childRanges.push({
        child,
        start: cursor,
        end: cursor + childMainSize,
      });

      cursor += childMainSize + this.gap;
    }
  }

  private findChildAtMainAxis(main: number): LayoutRect | null {
    let low = 0;
    let high = this.childRanges.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const range = this.childRanges[mid];

      if (main < range.start) {
        high = mid - 1;
      } else if (main > range.end) {
        low = mid + 1;
      } else {
        return range.child;
      }
    }

    return null;
  }

  private getLayoutMetrics(childCount: number): {
    isRow: boolean;
    mainStart: number;
    crossStart: number;
    mainSize: number;
    crossSize: number;
    availableMainSize: number;
  } {
    const isRow = this.direction === "row";
    const mainStart = isRow ? this.innerRect.x : this.innerRect.y;
    const crossStart = isRow ? this.innerRect.y : this.innerRect.x;
    const mainSize = isRow ? this.innerRect.width : this.innerRect.height;
    const crossSize = isRow ? this.innerRect.height : this.innerRect.width;
    const totalGap = this.gap * Math.max(0, childCount - 1);

    return {
      isRow,
      mainStart,
      crossStart,
      mainSize,
      crossSize,
      availableMainSize: Math.max(0, mainSize - totalGap),
    };
  }

  private getChildMainSize(
    config: LayoutChildConfig,
    weightedSize: number,
    totalWeight: number,
  ): number {
    if (config.fixedSize !== null) {
      return this.clampSize(config.fixedSize, config);
    }

    if (totalWeight <= 0) {
      return 0;
    }

    return this.clampSize(
      weightedSize * (Math.max(0, config.weight) / totalWeight),
      config,
    );
  }

  private setChildLayout(
    child: LayoutRect,
    cursor: number,
    childMainSize: number,
    metrics: ReturnType<LayoutGroup["getLayoutMetrics"]>,
  ): void {
    if (metrics.isRow) {
      child.setLayout(cursor, metrics.crossStart, childMainSize, metrics.crossSize);
      return;
    }

    child.setLayout(metrics.crossStart, cursor, metrics.crossSize, childMainSize);
  }

  private createChildConfig(options: LayoutChildOptions): LayoutChildConfig {
    return {
      weight: Math.max(0, options.weight ?? 1),
      fixedSize: options.fixedSize ?? null,
      minSize: Math.max(0, options.minSize ?? 0),
      maxSize: options.maxSize ?? null,
    };
  }

  private getChildConfig(child: LayoutRect): LayoutChildConfig {
    return this.childConfigs.get(child) ?? this.createChildConfig({});
  }

  private clampSize(size: number, config: LayoutChildConfig): number {
    const maxSize =
      config.maxSize === null ? Number.POSITIVE_INFINITY : Math.max(0, config.maxSize);

    return Math.max(config.minSize, Math.min(size, maxSize));
  }
}

export interface LayoutHorizontalOptions extends Omit<LayoutGroupOptions, "direction"> {}
export interface LayoutVerticalOptions extends Omit<LayoutGroupOptions, "direction"> {}

export class LayoutHorizontal extends LayoutGroup {
  public constructor(options: LayoutHorizontalOptions = {}) {
    super({ ...options, direction: "row" });
  }
}

export class LayoutVertical extends LayoutGroup {
  public constructor(options: LayoutVerticalOptions = {}) {
    super({ ...options, direction: "column" });
  }
}

export type { LayoutPadding };
