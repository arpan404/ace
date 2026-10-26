import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { ScreenInventory } from "@ace/protocol";
import { Helper, windowsEndpoint } from "./index.ts";

const Env = z.object({ ACE_WINDOWS_SCREEN_HELPER: z.string().min(1) });

it.runIf(process.platform === "win32")(
  "native Windows helper answers inventory then typed refusals without side effects",
  async () => {
    const command = Env.parse(process.env).ACE_WINDOWS_SCREEN_HELPER;
    const failures: Error[] = [];
    const helper = await Helper.open({
      command,
      platform: "win32",
      endpoint: windowsEndpoint(randomUUID()),
      nextId: () => randomUUID(),
      onFrame: () => {},
      onFailure: (error) => failures.push(error),
    });
    try {
      expect(helper.capabilities?.platform).toBe("windows");
      expect(helper.capabilities?.codecs).toContain("jpeg");
      expect(await helper.request({ op: "permissions" })).toEqual({
        screenRecording: true,
        accessibility: true,
      });
      const inventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
      expect(inventory.windows.length).toBeLessThanOrEqual(2048);
      expect(inventory.displays.length).toBeLessThanOrEqual(64);
      await expect(
        helper.request({ op: "ui.tree", allowlist: [], maxDepth: 1, maxNodes: 1 }),
      ).rejects.toMatchObject({ code: "target_gone" });
      await expect(
        helper.request({
          op: "open.url",
          bundleId: "ace.test",
          allowlist: ["ace.test"],
          url: "https://example.test/",
        }),
      ).rejects.toMatchObject({ code: "not_supported", phase: "rejected-before-dispatch" });
      expect(await helper.request({ op: "permissions" })).toEqual({
        screenRecording: true,
        accessibility: true,
      });
      const again = ScreenInventory.parse(await helper.request({ op: "targets" }));
      expect(again.windows.length).toBeLessThanOrEqual(2048);
      expect(again.displays.length).toBeLessThanOrEqual(64);
      expect(failures).toEqual([]);
    } finally {
      await helper.close();
    }
  },
);
