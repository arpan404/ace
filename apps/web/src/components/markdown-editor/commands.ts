import {
  CodeIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  ListChecksIcon,
  ListNumbersIcon,
  QuotesIcon,
  TextBIcon,
  TextHIcon,
  TextItalicIcon,
} from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";
import { parseChord } from "@/lib/keymap.ts";
import { toggleBlock } from "./blocks.ts";
import type { Change, Selection } from "./edits.ts";
import { insertLink, toggleInline } from "./inline.ts";

/** One formatting action: its toolbar button, its shortcut and the edit it makes. */
export interface FormatCommand {
  label: string;
  icon: IconGlyph;
  /** In keymap notation ("mod+b"); `mod` is ⌘ on Apple platforms, Ctrl elsewhere. */
  keys?: string;
  run(selection: Selection): Change;
}

/** The toolbar, in order, as GitHub's comment box offers it. */
export const formatCommands: readonly FormatCommand[] = [
  { label: "Heading", icon: TextHIcon, run: (s) => toggleBlock(s, "heading") },
  { label: "Bold", icon: TextBIcon, keys: "mod+b", run: (s) => toggleInline(s, "bold") },
  { label: "Italic", icon: TextItalicIcon, keys: "mod+i", run: (s) => toggleInline(s, "italic") },
  { label: "Quote", icon: QuotesIcon, keys: "shift+mod+.", run: (s) => toggleBlock(s, "quote") },
  { label: "Code", icon: CodeIcon, keys: "mod+e", run: (s) => toggleInline(s, "code") },
  { label: "Link", icon: LinkSimpleIcon, keys: "mod+k", run: insertLink },
  {
    label: "Bulleted list",
    icon: ListBulletsIcon,
    keys: "shift+mod+8",
    run: (s) => toggleBlock(s, "bullets"),
  },
  {
    label: "Numbered list",
    icon: ListNumbersIcon,
    keys: "shift+mod+7",
    run: (s) => toggleBlock(s, "numbers"),
  },
  { label: "Task list", icon: ListChecksIcon, run: (s) => toggleBlock(s, "tasks") },
];

/** What a key press reads as: the physical key, so ⇧7 is "7" and not "&". */
export interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function pressedKey(event: KeyPress): string {
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  if (event.code === "Period") return ".";
  return event.key.toLowerCase();
}

/** The command a key press runs, if any. `apple` decides whether `mod` is ⌘ or Ctrl. */
export function commandFor(event: KeyPress, apple: boolean): FormatCommand | undefined {
  const mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return undefined;
  const key = pressedKey(event);
  return formatCommands.find((command) => {
    if (!command.keys) return false;
    const chord = parseChord(command.keys);
    return chord.key === key && chord.shift === event.shiftKey;
  });
}
