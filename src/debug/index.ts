/**
 * Lightweight debug logger. Each entry is [tag, minLevel]: a message prints
 * when it shares at least one tag with the config AND its level >= that tag's
 * minLevel. Level 0 prints everything; higher values suppress lower-priority
 * messages.
 *
 * Edit `config` here to toggle subsystems.
 */
const config: readonly (readonly [string, number])[] = [
  ["actions",     0],
  ["spacetime",   5],
  ["zone",        5],
  ["vite",        5],
  ["definitions", 5],
  ["layout",      5],
  ["particles",   5],
  ["cards",       5],
] as const;

function shouldPrint(tags: string[], level: number): boolean {
  for (const [tag, priority] of config) {
    if (level >= priority && tags.includes(tag)) return true;
  }
  return false;
}

export const debug = {
  log(tags: string[], message: string, level = 0): void {
    if (shouldPrint(tags, level)) console.debug(message);
  },
  warn(tags: string[], message: string, level = 0): void {
    if (shouldPrint(tags, level)) console.warn(message);
  },
};
