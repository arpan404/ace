import { afterEach, describe, expect, it } from "vitest";
import { decodeBase64 } from "./base64.ts";
import { encodeBase64 } from "./base64-encode.ts";

const saved = {
  from: Reflect.get(Uint8Array, "fromBase64"),
  to: Reflect.get(Uint8Array.prototype, "toBase64"),
};
function useNative(native: boolean) {
  Object.defineProperty(Uint8Array, "fromBase64", {
    value: native ? saved.from : undefined,
    configurable: true,
    writable: true,
  });
  // oxlint-disable-next-line no-extend-native -- hide the codec to exercise the fallback; afterEach restores it.
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    value: native ? saved.to : undefined,
    configurable: true,
    writable: true,
  });
}
afterEach(() => useNative(true));

const bytes = Uint8Array.from({ length: 1000 }, (_, n) => (n * 37) % 256);

describe.each([
  ["the platform's native codec", true],
  ["the script fallback", false],
])("base64 with %s", (_name, native) => {
  it("round-trips any bytes, at every padding length", () => {
    useNative(native);
    for (const size of [0, 1, 2, 3, 999, 1000]) {
      const part = bytes.subarray(0, size);
      const text = encodeBase64(part);
      expect(text).toBe(Buffer.from(part).toString("base64"));
      expect([...decodeBase64(text, 1000)]).toEqual([...part]);
    }
  });

  it("refuses text that isn't canonical base64 or decodes past the limit", () => {
    useNative(native);
    for (const bad of ["abc", "ab=c", "a b=", "QQ==QQ==", "QR==", "QUJ=", "-_8="])
      expect(() => decodeBase64(bad, 1000), bad).toThrow("protocol");
    expect(() => decodeBase64(Buffer.from(bytes).toString("base64"), 999)).toThrow("protocol");
  });
});
