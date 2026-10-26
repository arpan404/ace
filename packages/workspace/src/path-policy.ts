/**
 * Windows lexical relative-path policy.
 *
 * Primary source: Microsoft "Naming Files, Paths, and Namespaces"
 * (Win32 apps, File and Directory Names + Paths + Namespaces sections).
 * No guessed restrictions beyond that page.
 *
 * Request paths are already normalized with "/" separators before this runs
 * (see SafeRoot.path). This module only adds win32-only lexical rejections;
 * POSIX behavior is owned by validRelativePath's base checks.
 */

// Reserved file names, case-insensitive, with or without an extension.
// Microsoft lists CON, PRN, AUX, NUL, COM1-9, COM superscript 1-3,
// LPT1-9, LPT superscript 1-3. Superscript digits are U+00B9, U+00B2, U+00B3.
const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "COM¹",
  "COM²",
  "COM³",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
  "LPT¹",
  "LPT²",
  "LPT³",
]);

/**
 * Win32-only lexical extras. Assumes base validRelativePath checks
 * (NUL, backslash, absolute, "..") already passed.
 *
 * Device and NT-namespace inputs ("//./", "//?/", "/??/") are absolute and
 * are rejected by the base validRelativePath checks (isAbsolute plus
 * win32.isAbsolute plus backslash); no separate check lives here.
 */
export function passesWindowsRelativePathPolicy(input: string): boolean {
  // Drive-relative: "C:tmp.txt" is relative to the current directory on C.
  if (/^[A-Za-z]:/.test(input)) return false;
  // ADS colon: "file.txt:stream". Any colon is rejected on win32 requests.
  if (input.includes(":")) return false;
  // Reserved characters (< > " | ? *).
  // "/" is the request separator, "\" is already rejected globally.
  if (/[<>"|?*]/.test(input)) return false;
  // Controls 1-31, checked without a control regex for lint clarity.
  for (const character of input) {
    const code = character.charCodeAt(0);
    if (code >= 1 && code <= 31) return false;
  }
  for (const part of input.split("/")) {
    // Empty (repeated separators, trailing slash) and "." normalize away
    // in SafeRoot.path and stay valid.
    if (part === "" || part === ".") continue;
    if (part.endsWith(" ") || part.endsWith(".")) return false;
    const rawStem = part.split(".")[0] ?? "";
    // Strip only ASCII trailing spaces before the DOS reserved comparison
    // ("CON .txt" is CON). Unicode whitespace stays significant and valid.
    const stem = rawStem.replace(/ +$/, "");
    if (WINDOWS_RESERVED.has(stem.toUpperCase())) return false;
  }
  return true;
}
