/** Windows name rules ("Naming Files, Paths, and Namespaces"), checked before any native call. */

// Reserved device stems, case-insensitive, with or without an extension.
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
 * One Windows file name: no reserved characters, controls, ":" streams, trailing space or dot,
 * and no reserved device stem ("CON .txt" is CON; only ASCII spaces are stripped).
 */
export function windowsNameAllowed(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (/[<>:"/\\|?*]/.test(name) || name.endsWith(" ") || name.endsWith(".")) return false;
  for (const character of name) if (character.charCodeAt(0) < 32) return false;
  const stem = (name.split(".")[0] ?? "").replace(/ +$/, "");
  return !WINDOWS_RESERVED.has(stem.toUpperCase());
}

/**
 * Win32-only lexical extras for a "/"-separated relative request path, after the base
 * validRelativePath checks. Empty and "." parts normalize away in SafeRoot.path.
 */
export function passesWindowsRelativePathPolicy(input: string): boolean {
  return input.split("/").every((part) => part === "" || part === "." || windowsNameAllowed(part));
}

// NTFS resolves names case-insensitively, so reserved entries match in any case on Windows.
/** Win32: whether any component is an upload temporary, in any case. */
export function windowsTransferTemporary(path: string): boolean {
  return path.split("/").some((part) => part.toLowerCase().startsWith(".ace-upload-"));
}
/** Win32: whether any component is `.git` or an upload temporary, in any case. */
export function windowsInternal(path: string): boolean {
  return (
    path.split("/").some((part) => part.toLowerCase() === ".git") || windowsTransferTemporary(path)
  );
}
