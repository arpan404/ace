import type { SettingsKey, SettingsProvenance } from "@ace/protocol";

/*
 * The settings page the phone draws (`settings.page`): sections of rows, each with its control,
 * its current value, where that value comes from, and why it can't change when it can't. Swift
 * renders any page from this alone (`SettingsPageView`); it never decides a title, a choice or
 * whether a value is allowed.
 */

export interface PageChoice {
  id: string;
  label: string;
}

/** What the phone sends back for a model row: the picker row's key and account, or null to clear. */
export interface ModelPick {
  key: string;
  account: string;
}

export type PageControl =
  | { kind: "toggle" }
  | { kind: "choice"; style: "menu" | "segmented"; choices: PageChoice[] }
  | { kind: "text"; placeholder: string }
  | { kind: "number" }
  | { kind: "list"; placeholder: string; add: string }
  | {
      kind: "model";
      /** Which models the sheet lists (`settings.models`). */
      picker: "role" | "utility";
      provider: string | null;
      /** "GPT-6", "Auto · Haiku 4.5" or "Not set". */
      label: string;
      /** The account it runs on, when the provider has several. */
      account: string | null;
      /** The choice that clears it: "Not set", "Auto". */
      clear: string;
      cleared: boolean;
    }
  | { kind: "link"; page: string; provider: string | null; label: string };

/** Where a value comes from, in words. */
export interface PageSource {
  kind: SettingsProvenance;
  label: string;
}

export interface PageRow {
  /** Unique in the page: the setting key, or "role.effort" for a part of one. */
  id: string;
  key: SettingsKey | null;
  title: string;
  control: PageControl;
  /** A toggle's boolean, a choice's id, text, a number, a list's strings, a model's pick. */
  value: unknown;
  /** What the current value means, when that changes with it. */
  note: string | null;
  source: PageSource | null;
  /** Why it can't change here; null when it can. */
  locked: string | null;
  /** Said instead of the control when there is nothing to choose. */
  empty: string | null;
}

export interface PageSection {
  id: string;
  title: string | null;
  footer: string | null;
  rows: PageRow[];
}

export interface SettingsPage {
  type: "settings.page";
  page: string;
  title: string;
  sections: PageSection[];
}

export type SettingsPageWrite =
  | { ok: true; page: SettingsPage }
  | { ok: false; message: string; page: SettingsPage | null };

/** A setting as the machine reported it. */
export interface ReadEntry {
  value: unknown;
  provenance: SettingsProvenance;
}
export type ReadValues = ReadonlyMap<SettingsKey, ReadEntry>;

const sources: Record<SettingsProvenance, string> = {
  defaults: "Default",
  global: "This machine",
  workspace: "Project",
  thread: "Thread",
  environment: "Environment override",
};
export function pageSource(entry: ReadEntry | undefined): PageSource | null {
  return entry ? { kind: entry.provenance, label: sources[entry.provenance] } : null;
}
export const lockedByEnvironment =
  "An environment variable on this machine sets this, so it can't change here.";
export function lockedReason(entry: ReadEntry | undefined): string | null {
  return entry?.provenance === "environment" ? lockedByEnvironment : null;
}
