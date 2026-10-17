/** A key as Electron's `before-input-event` reports it. */
export interface HandoffInput {
  type: string;
  key: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/** One event for Electron's `webContents.sendInputEvent`. */
export interface ReplayedKey {
  type: "keyDown" | "char" | "keyUp";
  keyCode: string;
  modifiers: ("shift" | "control" | "alt" | "meta")[];
}

/** Keys a person can type in the moment between asking for the address bar and getting it. */
const capacity = 64;

const accelerators = new Map([
  ["ArrowUp", "Up"],
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  [" ", "Space"],
  ["+", "Plus"],
]);

/**
 * A shortcut pressed in a native page (⌘L, ⌘F, ⌘T) moves typing to the app's own chrome, but
 * the OS keeps sending keys to the native view until the app's page has its field focused.
 * Between the shortcut and that moment the view keeps (never types) what the person types, and
 * the app replays it into its page once the field has focus, so the first characters land in
 * the field instead of being dropped by the view or typed into the page.
 */
export class FocusHandoff {
  private until = 0;
  private keys: HandoffInput[] = [];

  /** The shortcut was pressed at `now`; keys are kept until `now + ms` or until taken. */
  start(now: number, ms: number): void {
    this.until = now + ms;
    this.keys = [];
  }

  active(now: number): boolean {
    return now <= this.until;
  }

  /** True when the key belongs to the handoff (kept, not given to the page). */
  capture(now: number, input: HandoffInput): boolean {
    if (!this.active(now) || (input.type !== "keyDown" && input.type !== "keyUp")) return false;
    if (this.keys.length < capacity) this.keys.push(input);
    return true;
  }

  /** The kept keys, as events for the app's page; the handoff ends. */
  take(): ReplayedKey[] {
    const keys = this.keys;
    this.keys = [];
    this.until = 0;
    return keys.flatMap(replay);
  }
}

function replay(input: HandoffInput): ReplayedKey[] {
  const modifiers: ReplayedKey["modifiers"] = [];
  if (input.shift) modifiers.push("shift");
  if (input.control) modifiers.push("control");
  if (input.alt) modifiers.push("alt");
  if (input.meta) modifiers.push("meta");
  const single = [...input.key].length === 1;
  const keyCode = accelerators.get(input.key) ?? (single ? input.key.toUpperCase() : input.key);
  if (input.type === "keyUp") return [{ type: "keyUp", keyCode, modifiers }];
  const typed = single && !input.control && !input.meta && !input.alt;
  return [
    { type: "keyDown", keyCode, modifiers },
    ...(typed ? [{ type: "char" as const, keyCode: input.key, modifiers }] : []),
  ];
}
