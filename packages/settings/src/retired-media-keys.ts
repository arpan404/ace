import { isRetiredSettingsKey } from "@ace/protocol";

/**
 * The retired settings (`retiredSettingsKeys`, ADR 0208) a stored document still holds: a file
 * from an older build loads as if they were absent, and they are removed on the next read.
 */
export function retiredMediaKeys(settings: object): string[] {
  return Object.keys(settings).filter(isRetiredSettingsKey);
}
