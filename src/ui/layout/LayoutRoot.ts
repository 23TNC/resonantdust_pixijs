import { Rectangle } from "pixi.js";
import { getApp } from "../../app/AppContext";
import { LayoutRect, type LayoutRectOptions } from "./LayoutRect";

export interface LayoutRootOptions extends LayoutRectOptions {}

type AppResizeSource = {
  on(event: "resize", callback: () => void): void;
  off(event: "resize", callback: () => void): void;
  screen: Rectangle;
};

export class LayoutRoot extends LayoutRect {
  private readonly items: LayoutRect[] = [];
  private appResizeSource: AppResizeSource | null = null;
  private screenWidth: number;
  private screenHeight: number;

  private readonly handleAppResize = (): void => {
    const app = getApp();
    const { width, height } = app.renderer.screen;

    this.resize(width, height);
  };

  public constructor(options: LayoutRootOptions = {}) {
    super({
      ...options,
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 0,
      height: options.height ?? 0,
      padding: options.padding ?? 0,
    });

    this.screenWidth = Math.max(0, options.width ?? 0);
    this.screenHeight = Math.max(0, options.height ?? 0);

    this.bindAppResize();
  }

  public addLayoutItem<T extends LayoutRect>(item: T): T {
    if (!this.items.includes(item)) {
      this.items.push(item);
    }

    if (item.parent !== this) {
      this.addChild(item);
    }

    this.invalidateLayout();
    this.invalidateRender();

    return item;
  }

  public removeLayoutItem<T extends LayoutRect>(item: T): T | null {
    const index = this.items.indexOf(item);

    if (index < 0) {
      return null;
    }

    this.items.splice(index, 1);

    if (item.parent === this) {
      this.removeChild(item);
    }

    this.invalidateLayout();
    this.invalidateRender();

    return item;
  }

  public clearLayoutItems(): void {
    for (const item of this.items) {
      if (item.parent === this) {
        this.removeChild(item);
      }
    }

    this.items.length = 0;
    this.invalidateLayout();
    this.invalidateRender();
  }

  public getLayoutItems(): readonly LayoutRect[] {
    return this.items;
  }

  public bindAppResize(): void {
    if (this.appResizeSource) {
      return;
    }

    const app = getApp();
    const renderer = app.renderer as unknown as AppResizeSource;

    this.appResizeSource = renderer;
    renderer.on("resize", this.handleAppResize);

    this.resize(renderer.screen.width, renderer.screen.height);
  }

  public unbindAppResize(): void {
    if (!this.appResizeSource) {
      return;
    }

    this.appResizeSource.off("resize", this.handleAppResize);
    this.appResizeSource = null;
  }

  public resize(width: number, height: number): void {
    this.screenWidth = Math.max(0, width);
    this.screenHeight = Math.max(0, height);

    this.setLayout(0, 0, this.screenWidth, this.screenHeight);
    this.invalidateLayout();
    this.invalidateRender();
  }

  public getScreenRect(): Rectangle {
    return new Rectangle(0, 0, this.screenWidth, this.screenHeight);
  }

  public updateTree(): void {
    this.updateLayout();
    this.renderLayout();
  }

  public override destroy(options?: Parameters<LayoutRect["destroy"]>[0]): void {
    this.unbindAppResize();
    super.destroy(options);
  }
}
