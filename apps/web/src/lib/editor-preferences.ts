import { z } from "zod";
import { useDeviceSetting } from "./device-setting.ts";

/*
 * How the code editor looks and saves on this device (Settings › Editor). Kept with the layout's
 * storage like every per-device setting; every open editor reads it through the same store, so a
 * change shows in them at once. Each field falls back on its own, so a stored record from an
 * older or newer build keeps every value it still understands.
 */

export const autoSaveModes = ["off", "pause", "focus"] as const;
export type AutoSaveMode = (typeof autoSaveModes)[number];

export const editorFontSizes = [11, 12, 13, 14, 15, 16, 18, 20, 22, 24] as const;
export const editorLineSpacings = [
  { value: 1.45, label: "Tight" },
  { value: 1.7, label: "Normal" },
  { value: 2, label: "Relaxed" },
] as const;
export const editorTabSizes = [2, 4, 8] as const;
export const autoSaveDelays = [500, 1000, 2000, 5000] as const;

const fields = z.object({
  autoSave: z.enum(autoSaveModes).catch("off"),
  /** With "pause": how long typing rests before the file saves, in ms. */
  autoSaveDelay: z.number().int().min(200).max(60_000).catch(1000),
  fontSize: z.number().int().min(8).max(40).catch(13),
  /** The row height as a multiple of the font size. */
  lineSpacing: z.number().min(1).max(3).catch(1.7),
  /** A CSS font family list; empty is the app's monospace font. */
  fontFamily: z.string().max(300).catch(""),
  /** For files whose own indentation can't be detected. */
  tabSize: z.number().int().min(1).max(16).catch(2),
  insertSpaces: z.boolean().catch(true),
  wordWrap: z.boolean().catch(false),
  renderWhitespace: z.boolean().catch(false),
  indentGuides: z.boolean().catch(true),
  stickyScroll: z.boolean().catch(true),
  cursorBlinking: z.boolean().catch(false),
});
export const EditorPreferences = fields.catch(() => fields.parse({}));
export type EditorPreferences = z.infer<typeof EditorPreferences>;

export const defaultEditorPreferences: EditorPreferences = EditorPreferences.parse({});

const storageKey = "ace.editor.preferences";

/** A row's height in whole pixels, so rows never land between device pixels. */
export function editorLineHeight(preferences: EditorPreferences): number {
  return Math.max(
    preferences.fontSize + 2,
    Math.round(preferences.fontSize * preferences.lineSpacing),
  );
}

/** How one indent step is written in a file whose own indentation can't be detected. */
export function defaultIndent(preferences: EditorPreferences): { tabs: boolean; size: number } {
  return { tabs: !preferences.insertSpaces, size: preferences.tabSize };
}

/** This device's editor preferences and a setter that merges a change into them. */
export function useEditorPreferences(): [
  EditorPreferences,
  (change: Partial<EditorPreferences>) => void,
] {
  const [preferences, set] = useDeviceSetting(
    storageKey,
    EditorPreferences,
    defaultEditorPreferences,
  );
  return [preferences, (change) => set({ ...preferences, ...change })];
}
