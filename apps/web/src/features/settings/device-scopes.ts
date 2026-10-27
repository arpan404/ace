import { deviceAccessLevels } from "@ace/ui-core";

/** The grant a device holds, in words (`@ace/ui-core` device-pairing). */
export { deviceScopeLabels } from "@ace/ui-core";
export const deviceAccessOptions = deviceAccessLevels.map((level) => ({
  value: level.value,
  label: level.label,
}));
