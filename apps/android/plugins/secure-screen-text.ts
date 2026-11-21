/**
 * Pure text transform for the Ace secure-screen config plugin. This module has
 * no Expo imports so the MainActivity edit stays unit-testable; the thin
 * config plugin in this directory applies this transform to the prebuilt
 * project.
 */

export const SECURE_SCREEN_IMPORT = "import android.view.WindowManager";
const IMPORT_ANCHOR = "import android.os.Bundle";
export const SECURE_SCREEN_CALL = "window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)";
const SUPER_ANCHOR = "super.onCreate(null)";
const SECURE_SCREEN_COMMENT =
  "// Fail-closed: exclude this window from the switcher before its first frame.";

function replaceOnce(contents: string, anchor: string, replacement: string, what: string): string {
  const count = contents.split(anchor).length - 1;
  if (count !== 1)
    throw new Error(
      `Expo MainActivity template changed; check ace secure-screen wiring (expected one ${what}).`,
    );
  return contents.replace(anchor, replacement);
}

/**
 * Insert the fail-closed FLAG_SECURE wiring into an Expo MainActivity.
 * Idempotent; throws when the generated template shape is unexpected so
 * prebuild drift fails loudly instead of shipping an unsecured first frame.
 */
export function applySecureScreenToMainActivity(contents: string): string {
  let edited = contents;
  if (!edited.includes(SECURE_SCREEN_IMPORT)) {
    edited = replaceOnce(
      edited,
      IMPORT_ANCHOR,
      `${SECURE_SCREEN_IMPORT}\n${IMPORT_ANCHOR}`,
      "Bundle import",
    );
  }
  if (!edited.includes(SECURE_SCREEN_CALL)) {
    edited = replaceOnce(
      edited,
      SUPER_ANCHOR,
      `${SECURE_SCREEN_COMMENT}\n    ${SECURE_SCREEN_CALL}\n    ${SUPER_ANCHOR}`,
      "super.onCreate",
    );
  }
  return edited;
}
