export const APPEARANCE_STORAGE_KEY = "ace.appearance";
export const RETURN_SENDS_STORAGE_KEY = "ace.keyboard.returnSends";

export type AppearanceMode = "system" | "light" | "dark";
export type ColorScheme = "light" | "dark";

export const APPEARANCE_MODES: ReadonlyArray<{
  readonly id: AppearanceMode;
  readonly label: string;
}> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/**
 * Normalize a stored appearance value. Unknown, missing, or mistyped values
 * fall back to "system", matching iOS `PhoneAppearance.label(_:)` which
 * renders any unknown id as "System".
 */
export function parseAppearanceMode(value: unknown): AppearanceMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function appearanceLabel(mode: AppearanceMode): string {
  const found = APPEARANCE_MODES.find((entry) => entry.id === mode);
  return found?.label ?? "System";
}

export function labelForStoredAppearance(value: unknown): string {
  return appearanceLabel(parseAppearanceMode(value));
}

/** Resolve the effective scheme for a mode given the OS scheme. */
export function resolveAppearanceScheme(
  mode: AppearanceMode,
  systemScheme: ColorScheme,
): ColorScheme {
  return mode === "light" || mode === "dark" ? mode : systemScheme;
}

/**
 * Normalize the stored "Send with Return" flag. Only an explicit `true`
 * enables it; anything else (missing, strings, numbers) stays off, so a
 * corrupt default can never flip the composer's Return behavior.
 */
export function parseReturnSends(value: unknown): boolean {
  return value === true;
}
