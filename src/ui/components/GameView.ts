import { Ticker } from "pixi.js";
import { LayoutRoot, type LayoutPadding, type LayoutRootOptions } from "@/ui/layout";
import { LayoutHorizontal, LayoutVertical } from "@/ui/layout";
import { Panel } from "@/ui/components/Panel";

export interface GameViewOptions extends LayoutRootOptions {
  viewId: number;
  width: number;
  height: number;
  padding?: LayoutPadding;
  gap?: number;
  titleBarSize?: number;
}

export interface GameViewWeights {
  bodyColumns?: {
    left?: number;
    center?: number;
    right?: number;
  };
  leftPanels?: {
    top?: number;
    middle?: number;
    bottom?: number;
  };
  centerPanels?: {
    top?: number;
    bottom?: number;
  };
  rightPanels?: {
    top?: number;
    bottom?: number;
  };
}

export class GameView extends LayoutRoot {
  public readonly viewId: number;

  public readonly mainLayout: LayoutVertical;
  public readonly titleBar: Panel;
  public readonly bodyLayout: LayoutHorizontal;

  public readonly leftColumn: LayoutVertical;
  public readonly centerColumn: LayoutVertical;
  public readonly rightColumn: LayoutVertical;

  public readonly leftTopPanel: Panel;
  public readonly leftMiddlePanel: Panel;
  public readonly leftBottomPanel: Panel;

  public readonly centerTopPanel: Panel;
  public readonly centerBottomPanel: Panel;

  public readonly rightTopPanel: Panel;
  public readonly rightBottomPanel: Panel;

  private readonly titleBarSize: number;

  public constructor(options: GameViewOptions) {
    super(options);

    this.viewId = options.viewId;

    const gap = Math.max(0, options.gap ?? 8);
    this.titleBarSize = Math.max(0, options.titleBarSize ?? 80);

    this.mainLayout = this.addLayoutItem(new LayoutVertical({ gap }));

    this.titleBar = this.mainLayout.addLayoutItem(new Panel(), {
      fixedSize: this.titleBarSize,
    });
    
    this.bodyLayout = this.mainLayout.addLayoutItem(new LayoutHorizontal({ gap }), {
      weight: 1,
    });
    
    this.leftColumn = this.bodyLayout.addLayoutItem(new LayoutVertical({ gap }), {
      weight: 1,
    });
    
    this.centerColumn = this.bodyLayout.addLayoutItem(new LayoutVertical({ gap }), {
      weight: 2,
    });

    this.rightColumn = this.bodyLayout.addLayoutItem(new LayoutVertical({ gap }), {
      weight: 1,
    });

    this.leftTopPanel = this.leftColumn.addLayoutItem(new Panel(), { weight: 1 });
    this.leftMiddlePanel = this.leftColumn.addLayoutItem(new Panel(), { weight: 1 });
    this.leftBottomPanel = this.leftColumn.addLayoutItem(new Panel(), { weight: 1 });
    
    this.centerTopPanel = this.centerColumn.addLayoutItem(new Panel(), { weight: 1 });
    this.centerBottomPanel = this.centerColumn.addLayoutItem(new Panel(), { weight: 1 });

    this.rightTopPanel = this.rightColumn.addLayoutItem(new Panel(), { weight: 1 });
    this.rightBottomPanel = this.rightColumn.addLayoutItem(new Panel(), { weight: 1 });
  }

  public setTitleBarSize(size: number): void {
    this.mainLayout.setChildLayoutOptions(this.titleBar, {
      fixedSize: Math.max(0, size),
    });
  }

  public setWeights(weights: GameViewWeights): void {
    if (weights.bodyColumns) {
      this.setBodyColumnWeights(weights.bodyColumns);
    }

    if (weights.leftPanels) {
      this.setLeftPanelWeights(weights.leftPanels);
    }

    if (weights.centerPanels) {
      this.setCenterPanelWeights(weights.centerPanels);
    }

    if (weights.rightPanels) {
      this.setRightPanelWeights(weights.rightPanels);
    }
  }

  public setBodyColumnWeights(weights: {
    left?: number;
    center?: number;
    right?: number;
  }): void {
    this.setWeight(this.bodyLayout, this.leftColumn, weights.left);
    this.setWeight(this.bodyLayout, this.centerColumn, weights.center);
    this.setWeight(this.bodyLayout, this.rightColumn, weights.right);
  }

  public setLeftPanelWeights(weights: {
    top?: number;
    middle?: number;
    bottom?: number;
  }): void {
    this.setWeight(this.leftColumn, this.leftTopPanel, weights.top);
    this.setWeight(this.leftColumn, this.leftMiddlePanel, weights.middle);
    this.setWeight(this.leftColumn, this.leftBottomPanel, weights.bottom);
  }

  public setCenterPanelWeights(weights: { top?: number; bottom?: number }): void {
    this.setWeight(this.centerColumn, this.centerTopPanel, weights.top);
    this.setWeight(this.centerColumn, this.centerBottomPanel, weights.bottom);
  }

  public setRightPanelWeights(weights: { top?: number; bottom?: number }): void {
    this.setWeight(this.rightColumn, this.rightTopPanel, weights.top);
    this.setWeight(this.rightColumn, this.rightBottomPanel, weights.bottom);
  }

  public resetWeights(): void {
    this.setTitleBarSize(this.titleBarSize);

    this.setBodyColumnWeights({
      left: 1,
      center: 2,
      right: 1,
    });

    this.setLeftPanelWeights({
      top: 1,
      middle: 1,
      bottom: 1,
    });

    this.setCenterPanelWeights({
      top: 1,
      bottom: 1,
    });

    this.setRightPanelWeights({
      top: 1,
      bottom: 1,
    });
  }

  public update(_ticker: Ticker): void {
    this.updateTree();
  }

  private setWeight(
    parent: LayoutHorizontal | LayoutVertical,
    child: LayoutHorizontal | LayoutVertical | Panel,
    weight: number | undefined,
  ): void {
    if (weight === undefined) {
      return;
    }

    parent.setChildLayoutOptions(child, {
      weight: Math.max(0, weight),
    });
  }
}
