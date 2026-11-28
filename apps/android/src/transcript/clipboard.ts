/**
 * Copy for transcript code blocks (A05.02).
 *
 * The native `AceNative.copyText` clipboard write keeps code copying out of
 * the JS bridge payload path and matches iOS Copy in the code header. The
 * loader is injectable so behavior tests prove both paths without the bridge.
 * Never throws: a missing bridge must not break the transcript.
 */

export interface ClipboardNative {
  copyText(text: string): unknown;
}

export function copyCodeText(text: string, loader?: () => ClipboardNative): boolean {
  try {
    const native = loader !== undefined ? loader() : loadAceNative();
    const result = native.copyText(text);
    if (result === false) return false;
    if (isPromiseLike(result)) result.catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function loadAceNative(): ClipboardNative {
  // Lazy so unit tests and bundles without the module stay alive.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const expo = require("expo") as {
    requireNativeModule(name: string): ClipboardNative;
  };
  return expo.requireNativeModule("AceNative");
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "catch" in value &&
    typeof (value as { catch: unknown }).catch === "function"
  );
}
