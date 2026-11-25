// SPDX-License-Identifier: Apache-2.0

/**
 * The device words, read from the one catalog both backends share
 * (`native/daemon/catalog/devices.json`, ADR 0225 safeguard 3). A refusal this package raises
 * without the addon comes from here; the Rust crate embeds the same file, so neither side
 * retypes a message.
 */
import catalog from "../../../native/daemon/catalog/devices.json" with { type: "json" };
import type { DeviceErrorCode } from "./sdk.ts";

export interface CatalogWord {
  code: DeviceErrorCode;
  message: string;
  hint: string;
}

const words = catalog.platform as Record<string, CatalogWord>;
const toolWords = (catalog.tools ?? {}) as Record<string, string>;

/** The tool words that are not a whole refusal, by the key the catalog gives them. */
export type CatalogHintKey =
  | "downloadHint"
  | "againHint"
  | "scrcpyHint"
  | "downloadTimeout"
  | "simulatorPasteTimeoutHint"
  | "simulatorPasteFailedHint"
  | "androidNoKeyHint"
  | "iosNoKeyHint";

/** The refusal `key` names, as the catalog spells it. */
export function catalogWord(key: string): CatalogWord {
  const word = words[key];
  if (!word) throw new Error(`ace's device catalog names no word for ${key}`);
  return word;
}

/** A tool word the catalog holds (a download's hint, its timeout's text). */
export function catalogHint(key: CatalogHintKey | string): string {
  const word = toolWords[key];
  if (!word) throw new Error(`ace's device catalog names no tool word for ${key}`);
  return word;
}

/** Every key the catalog holds, for the check that both backends render the same words. */
export function catalogKeys(): string[] {
  return Object.keys(words);
}
