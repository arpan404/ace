import { describe, expect, it } from "vitest";
import { desktopTarget } from "./desktop.ts";

const token = "ab".repeat(32);

describe("desktop daemon hand-off", () => {
  it("connects to the daemon the desktop bridge hands over", async () => {
    const scope = {
      ace: { daemon: { connection: async () => ({ mode: "daemon", url: "ws://127.0.0.1:4242/", token }) } },
    };
    await expect(desktopTarget(scope)).resolves.toEqual({ url: "ws://127.0.0.1:4242/", token });
  });

  it("falls back to the browser flow without a bridge, in fake mode, or when the bridge fails", async () => {
    await expect(desktopTarget({})).resolves.toBeUndefined();
    await expect(
      desktopTarget({ ace: { daemon: { connection: async () => ({ mode: "fake" }) } } }),
    ).resolves.toBeUndefined();
    await expect(
      desktopTarget({ ace: { daemon: { connection: async () => Promise.reject(new Error("down")) } } }),
    ).resolves.toBeUndefined();
  });
});
