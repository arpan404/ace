import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { BrowserService } from "@ace/browser";
import { InteractionMeasurement } from "@ace/protocol";
import { BrowserBackend } from "./backend.ts";
import { EmbeddedPageGroup } from "./page-group.ts";
import { FakePage } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

class NativePage extends FakePage {
  viewport() {
    return { width: 1280, height: 720 };
  }
  place() {}
  async placementReady() {}
  isShown() {
    return false;
  }
  setAgentControl() {}
}

async function setup(native: boolean, oversized: boolean) {
  const home = await mkdtemp(join(tmpdir(), "ace-native-trace-"));
  cleanups.push(() => rm(home, { force: true, recursive: true }));
  const service = new BrowserService({ dataDir: home, id: () => "trace-test", now: () => 1000 });
  cleanups.push(() => service.close());
  const page = new NativePage();
  page.results.set("Page.createIsolatedWorld", { executionContextId: 1 });
  const cdp = page.cdp.bind(page);
  page.cdp = async (method, params) => {
    if (method === "Tracing.end") {
      page.emit("Tracing.dataCollected", {
        value: [
          {
            name: "TimeStamp",
            ts: 1_000_000,
            pid: 1,
            tid: 1,
            args: { data: { message: "ace-measure-trace-test", frame: "main" } },
          },
          {
            name: "SetLayerTreeId",
            ts: 1_000_000,
            pid: 1,
            args: { data: { frame: "main", layerTreeId: 1 } },
          },
          ...Array.from({ length: 30 }, (_, i) => ({
            name: "DrawFrame",
            ts: 1_000_000 + (i + 1) * 16000,
            pid: 1,
            args: { layerTreeId: 1 },
          })),
          ...Array.from({ length: 30 }, () => ({
            name: "Unrelated",
            payload: "x".repeat(70 * 1024),
          })),
          ...(oversized ? [{ name: "TooLarge", payload: "x".repeat(300 * 1024) }] : []),
        ],
      });
      page.emit("Tracing.tracingComplete", { dataLossOccurred: false });
    }
    return cdp(method, params);
  };
  const group = new EmbeddedPageGroup(
    async () => page,
    async () => {},
  );
  const desktop = new BrowserBackend(
    {
      async open() {
        if (!native) return page;
        await group.openTab();
        return group;
      },
    },
    { log() {} },
  );
  const sizes: number[] = [];
  const relay = service.registerEmbedded({
    send(message) {
      desktop.handle(message);
      return true;
    },
    close() {
      desktop.detach();
    },
  });
  desktop.attach({
    backendId: relay.id,
    connectionId: "desktop",
    send(text) {
      sizes.push(Buffer.byteLength(text));
      relay.handle(JSON.parse(text));
      return true;
    },
  });
  await service.open({ threadId: "thread", workspaceId: "workspace" });
  return { service, sizes };
}

test.each([true, false])(
  "large trace batches reach public measurement through the %s native tab envelope",
  async (native) => {
    const t = await setup(native, false);
    const measurement = InteractionMeasurement.parse(
      await t.service.execute("thread", {
        action: "measure_interaction",
        observeMs: 500,
        filmstrip: false,
      }),
    );
    expect(measurement.frames).toBe(30);
    expect(measurement.notes).not.toContain(
      "Capture evidence was incomplete or reached its bound.",
    );
    expect(Math.max(...t.sizes)).toBeLessThan(1024 * 1024);
  },
);

test("a native trace with an oversized event reports incomplete measurement evidence", async () => {
  const t = await setup(true, true);
  const measurement = InteractionMeasurement.parse(
    await t.service.execute("thread", {
      action: "measure_interaction",
      observeMs: 500,
      filmstrip: false,
    }),
  );
  expect(measurement.frames).toBe(30);
  expect(measurement.verdict).toBe("inconclusive");
  expect(measurement.notes).toContain("Capture evidence was incomplete or reached its bound.");
  expect(Math.max(...t.sizes)).toBeLessThan(1024 * 1024);
});
