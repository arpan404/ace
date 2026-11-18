import { describe, expect, it } from "vitest";
import { appKeyPair, appSignatureProven, appSocketSignature } from "./app-signature.ts";

const app = appKeyPair(new Uint8Array(32).fill(1));
const other = appKeyPair(new Uint8Array(32).fill(2));

describe("the app's signature for a daemon it didn't start", () => {
  it("verifies for the run and port it was made for, by the registered key", () => {
    expect(appSignatureProven([app.x], 4242, "run", appSocketSignature(app, 4242, "run"))).toBe(
      true,
    );
  });

  it.each([
    ["another port", appSocketSignature(app, 4243, "run")],
    ["another run of the daemon", appSocketSignature(app, 4242, "earlier")],
    ["a key that isn't registered", appSocketSignature(other, 4242, "run")],
    ["no signature at all", "x".repeat(86)],
  ])("is worthless for %s", (_what, proof) => {
    expect(appSignatureProven([app.x], 4242, "run", proof)).toBe(false);
  });

  it("verifies nothing when no key is registered", () => {
    expect(appSignatureProven([], 4242, "run", appSocketSignature(app, 4242, "run"))).toBe(false);
  });

  it("is the same key pair for the same seed, so a key kept in the keychain signs again", () => {
    expect(appKeyPair(new Uint8Array(32).fill(1))).toEqual(app);
  });
});
