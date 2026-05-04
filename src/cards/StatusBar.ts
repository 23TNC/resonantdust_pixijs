import { Text } from "pixi.js";
import type { AspectEntry } from "../definitions/DefinitionManager";

/** One character (or short sequence) shown per aspect when that aspect is
 *  present on a card.  Edit this table to change what appears in the bar. */
const ASPECT_ICONS: Readonly<Record<string, string>> = {
  // resources
  labor:     "🔨",
  wood:      "🪵",
  stone:     "🪨",
  metal:     "⬛",
  food:      "🌾",
  fuel:      "🪔",
  // elements
  earth:     "🌍",
  water:     "💧",
  fire:      "🔥",
  wind:      "💨",
  light:     "✨",
  dark:      "🌑",
  // alignment
  order:     "⚖️",
  chaos:     "🌀",
  // faculties
  corpus:    "🫀",
  sollertia: "🎯",
  anima:     "🌟",
  aether:    "🔮",
  // dimensions
  mind:      "🧠",
  body:      "💪",
  skill:     "⚒️",
  soul:      "🕊️",
  // activities
  combat:    "⚔️",
  defence:   "🛡️",
  craft:     "🔧",
  explore:   "🧭",
  quality:   "💎",
  // states
  fleeting:  "⏳",
  memory:    "📜",
};

/** Game- or UI-driven flags that the status bar can reflect independently of
 *  the card's static aspects.  Extend this as new states are needed. */
export interface StatusState {
  // placeholder — add fields here as game states emerge
}

export class StatusBar {
  readonly text: Text;

  constructor(fontSize: number) {
    this.text = new Text({
      text: "",
      style: {
        fontFamily: "Segoe UI",
        fontSize,
        align: "left",
      },
    });
    this.text.anchor.set(0, 0);
  }

  update(aspects: readonly AspectEntry[], _state?: StatusState): void {
    const icons: string[] = [];
    for (const [name] of aspects) {
      const icon = ASPECT_ICONS[name];
      if (icon !== undefined) icons.push(icon);
    }
    this.text.text = icons.join(" ");
  }

  destroy(): void {
    this.text.destroy();
  }
}
