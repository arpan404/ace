/**
 * Base64 data URLs carry whole attachments, often several megabytes. They are read by index and
 * scanned in one loop, never matched with a regular expression: in a long-running daemon V8 can
 * run out of stack matching a pattern against a string this long ("Maximum call stack size
 * exceeded"), which refused every large screenshot sent to Claude.
 */
export function base64DataUrl(url: string): { mimeType: string; data: string } | undefined {
  if (!url.startsWith("data:")) return undefined;
  const marker = url.indexOf(";base64,");
  if (marker <= 5) return undefined;
  const mimeType = url.slice(5, marker);
  if (mimeType.includes(",") || mimeType.includes(";")) return undefined;
  return { mimeType, data: url.slice(marker + ";base64,".length) };
}

/** True for a non-empty base64 alphabet string with at most two trailing `=`. */
export function isBase64(value: string): boolean {
  let end = value.length;
  while (end > 0 && value.length - end < 2 && value.charCodeAt(end - 1) === 61) end--;
  if (end === 0) return false;
  for (let i = 0; i < end; i++) {
    const code = value.charCodeAt(i);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    )
      return false;
  }
  return true;
}
