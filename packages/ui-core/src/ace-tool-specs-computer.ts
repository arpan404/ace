import type { InputKind } from "./ace-tool-problems.ts";
import {
  quote,
  say,
  str,
  verbs,
  type AceToolSpec,
  type ToolWords,
  type Verbs,
} from "./ace-tool-specs.ts";
import { modifierPrefix, playwrightChord } from "./key-chord.ts";

/*
 * Computer use's background tools as sentences: `screen_apps` lists apps, `screen_state` looks at
 * one ("Looked at Calculator") and `screen_act` runs a batch of actions, read from the batch
 * itself: one action says what it did ("Chose File › New in TextEdit"), several name their verbs
 * in order ("Clicked, typed in Calculator"). Pure.
 */

type Args = Record<string, unknown>;

const record = (value: unknown): Args | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Args)
    : undefined;

/** The batch's actions that are objects with a `type`; anything else is skipped. */
function actionsOf(args: Args): Args[] {
  const list = Array.isArray(args["actions"]) ? args["actions"] : [];
  return list.flatMap((entry) => {
    const action = record(entry);
    return action && typeof action["type"] === "string" ? [action] : [];
  });
}

/** Typed text worth quoting: present, and not what redaction left. */
function shownText(args: Args): string | undefined {
  const text = str(args, "text");
  return text && text !== "[redacted]" ? text : undefined;
}

function menuPath(action: Args): string | undefined {
  const path = Array.isArray(action["path"])
    ? action["path"].filter((part): part is string => typeof part === "string" && !!part.trim())
    : [];
  return path.length ? path.map((part) => part.trim()).join(" › ") : undefined;
}

interface Phrase {
  verbs: Verbs;
  /** What follows the verb when this action is the batch's only one. */
  alone: string;
  /** What follows the verb among others; short or nothing. */
  among: string;
  input: InputKind | undefined;
  /** Names the app in the middle: "Brought TextEdit forward". */
  forward?: true;
}

const chose: Verbs = ["Chose", "Choosing", "Choose"];

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** An action whose detail shows only when it is the batch's one action. */
const plain = (words: Verbs, alone = "", input?: InputKind): Phrase => ({
  verbs: words,
  alone,
  among: "",
  input,
});

/** "⌘-clicked" from "Clicked" with ⌘ held; the verbs as they are with nothing held. */
function held(action: Args, words: Verbs): Verbs {
  const modifiers = Array.isArray(action["modifiers"])
    ? action["modifiers"].filter((value): value is string => typeof value === "string")
    : [];
  const prefix = modifierPrefix(modifiers);
  if (!prefix) return words;
  return [
    `${prefix}-${lowerFirst(words[0])}`,
    `${prefix}-${lowerFirst(words[1])}`,
    `${prefix}-${lowerFirst(words[2])}`,
  ];
}

function clickVerbs(action: Args): Verbs {
  const count = typeof action["count"] === "number" ? action["count"] : 1;
  if (action["button"] === "right") return ["Right-clicked", "Right-clicking", "Right-click"];
  if (action["button"] === "middle") return ["Middle-clicked", "Middle-clicking", "Middle-click"];
  if (count === 2) return ["Double-clicked", "Double-clicking", "Double-click"];
  if (count === 3) return ["Triple-clicked", "Triple-clicking", "Triple-click"];
  if (typeof action["hold_ms"] === "number" && action["hold_ms"] > 0)
    return ["Long-pressed", "Long-pressing", "Long-press"];
  return verbs.clicked;
}

const windowVerbs: Record<string, Verbs> = {
  close: ["Closed the window", "Closing the window", "Close the window"],
  minimize: ["Minimized the window", "Minimizing the window", "Minimize the window"],
  restore: ["Restored the window", "Restoring the window", "Restore the window"],
  zoom: ["Zoomed the window", "Zooming the window", "Zoom the window"],
  fullscreen: [
    "Made the window full screen",
    "Making the window full screen",
    "Make the window full screen",
  ],
  raise: ["Raised the window", "Raising the window", "Raise the window"],
  move: ["Moved the window", "Moving the window", "Move the window"],
  resize: ["Resized the window", "Resizing the window", "Resize the window"],
};

function waitedFor(action: Args): Phrase {
  const text = str(action, "text");
  const what = text ? quote(text) : "an element";
  const rest = action["gone"] === true ? ` ${what} to go` : ` ${what}`;
  return { verbs: verbs.waited, alone: rest, among: rest, input: undefined };
}

function phrase(action: Args): Phrase | undefined {
  switch (action["type"]) {
    case "click":
      return plain(held(action, clickVerbs(action)), "", "click");
    case "move":
      return plain(["Hovered", "Hovering", "Hover"], "", "click");
    case "paste": {
      const text = shownText(action);
      return plain(verbs.pasted, text ? ` ${quote(text)}` : "", "paste");
    }
    case "scroll_to":
      return plain(
        ["Scrolled to an element", "Scrolling to an element", "Scroll to an element"],
        "",
        "scroll",
      );
    case "window": {
      const words = windowVerbs[str(action, "op") ?? ""];
      return words ? plain(words, "", "act") : undefined;
    }
    case "wait_for":
      return waitedFor(action);
    case "type": {
      const text = shownText(action);
      return plain(verbs.typed, text ? ` ${quote(text)}` : "", "type");
    }
    case "key": {
      const key = str(action, "key");
      const chord = key ? ` ${playwrightChord(key)}` : " a key";
      return { verbs: verbs.pressed, alone: chord, among: chord, input: "key" };
    }
    case "set_value": {
      const value = action["value"];
      const shown =
        typeof value === "string" && value !== "[redacted]"
          ? ` to ${quote(value)}`
          : typeof value === "number" || typeof value === "boolean"
            ? ` to ${String(value)}`
            : "";
      return plain(["Set", "Setting", "Set"], ` a value${shown}`, "act");
    }
    case "select_text": {
      const text = shownText(action);
      const placed = action["cursor"] === "before" || action["cursor"] === "after";
      if (placed)
        return plain(["Placed the cursor", "Placing the cursor", "Place the cursor"], "", "act");
      return plain(["Selected", "Selecting", "Select"], text ? ` ${quote(text)}` : " text", "act");
    }
    case "scroll": {
      const direction = str(action, "direction");
      return plain(verbs.scrolled, direction ? ` ${direction}` : "", "scroll");
    }
    case "action": {
      const name = str(action, "name");
      return plain(["Used", "Using", "Use"], name ? ` ${quote(name)}` : " an action", "act");
    }
    case "menu": {
      const path = menuPath(action);
      const where = path ? ` ${path}` : " a menu item";
      return { verbs: chose, alone: where, among: where, input: "act" };
    }
    case "focus":
      return plain(["Focused", "Focusing", "Focus"], " an element", "act");
    case "drag":
      return plain(held(action, ["Dragged", "Dragging", "Drag"]), "", "click");
    case "activate":
      return { ...plain(["Brought", "Bringing", "Bring"], "", "other"), forward: true };
    default:
      return undefined;
  }
}

/** One sentence for a batch: its one action in full, or its actions' verbs in order. */
function batchWords(args: Args, subject: string | undefined): ToolWords {
  const app = subject ?? "the app";
  const actions = actionsOf(args);
  const phrases = actions.flatMap((action) => phrase(action) ?? []);
  const waits = actions.some((action) => action["type"] === "wait");
  const [only] = phrases;
  if (phrases.length === 0)
    return waits
      ? say(["Waited", "Waiting", "Wait"], ` in ${app}`)
      : say(["Used", "Using", "Use"], ` ${app}`);
  if (phrases.length === 1 && only) {
    if (only.forward) return say(only.verbs, ` ${app} forward`);
    return say(only.verbs, `${only.alone} in ${app}`);
  }
  // Repeats of one fragment ("Clicked, clicked") read once.
  const parts: Phrase[] = [];
  for (const entry of phrases)
    if (!parts.some((part) => part.verbs[0] === entry.verbs[0] && part.among === entry.among))
      parts.push(entry);
  const tense = (index: 0 | 1 | 2) =>
    parts
      .map((part, at) => {
        const words = part.verbs[index] + (part.forward ? " it forward" : part.among);
        return at === 0 ? words : lowerFirst(words);
      })
      .join(", ") + ` in ${app}`;
  return { past: tense(0), running: tense(1), awaiting: tense(2) };
}

function batchInput(args: Args): InputKind | undefined {
  const inputs = actionsOf(args).flatMap((action) => phrase(action)?.input ?? []);
  const [first] = inputs;
  if (!first) return undefined;
  return inputs.every((input) => input === first) ? first : "act";
}

const looked: Verbs = ["Looked at", "Looking at", "Look at"];

export const computerSpecs: Readonly<Record<string, AceToolSpec>> = {
  screen_apps: {
    family: "screen",
    words: ({ args }) => {
      const query = str(args, "query");
      return query
        ? say(["Searched apps for", "Searching apps for", "Search apps for"], ` ${quote(query)}`)
        : say(verbs.listed, " apps");
    },
  },
  screen_state: {
    family: "screen",
    words: ({ subject }) => say(looked, ` ${subject ?? "an app"}`),
  },
  screen_act: {
    family: "screen",
    input: batchInput,
    words: ({ args, subject }) => batchWords(args, subject),
  },
};
