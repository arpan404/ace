import { describe, expect, it } from "vitest";
import { allowedOrigin } from "./index.ts";

describe("which addresses a browser session may load", () => {
  it("allows any web address by default, defers to a host hook when set, and never loads non-web schemes", async () => {
    expect(await allowedOrigin("t", "http://localhost:3000")).toBe(true);
    expect(await allowedOrigin("t", "http://[::1]:3000")).toBe(true);
    expect(await allowedOrigin("t", "https://example.test")).toBe(true);
    expect(
      await allowedOrigin(
        "t",
        "https://example.test",
        ({ origin }) => origin !== "https://example.test",
      ),
    ).toBe(false);
    expect(await allowedOrigin("t", "file:///tmp/a", () => true)).toBe(false);
    expect(await allowedOrigin("t", "https://user:pass@example.test", () => true)).toBe(false);
  });
});
