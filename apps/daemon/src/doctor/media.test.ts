import { afterEach, expect, it } from "vitest";
import { mediaFeature, type MediaPorts } from "./media.ts";
import { doctorTestContext } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const entry = (over: Record<string, unknown>) => ({
  step: "encode",
  codec: "avc1.640028",
  backend: "vt",
  hardware: true,
  zeroCopy: true,
  state: "ok",
  maxWidth: 4096,
  maxHeight: 2304,
  ...over,
});

function ports(output: unknown): MediaPorts {
  return {
    binary: () => "/bin/ace-media",
    probe: async () => {
      if (output instanceof Error) throw output;
      return typeof output === "string" ? output : JSON.stringify(output);
    },
  };
}

async function run(media: MediaPorts, id: string) {
  const made = await doctorTestContext();
  cleanups.push(made.cleanup);
  const check = mediaFeature(media)
    .checks(made.context)
    .find((candidate) => candidate.id === id);
  if (!check) throw new Error(`missing check ${id}`);
  return check.run(new AbortController().signal);
}

it("a machine whose hardware trials worked is fine, and every step is listed", async () => {
  const verdict = await run(
    ports({
      probeMs: 420,
      capabilities: [entry({}), entry({ step: "scale", codec: undefined, hardware: false })],
      ranking: [],
    }),
    "media.capabilities",
  );
  expect(verdict.status).toBe("ok");
  expect(verdict.message).toMatch(/^Video encodes on hardware here\. The probe took 420\.0 ms\./);
  expect(verdict.message).toContain("encode avc1.640028 on vt: hardware, ok, up to 4096×2304");
  expect(verdict.message).toContain("scale on vt: processor, ok");
});

it("a timed-out or failed hardware trial warns and still shows the table", async () => {
  const verdict = await run(
    ports({
      probeMs: 2_010,
      capabilities: [
        entry({ backend: "vaapi", state: "timed-out", hardware: false, maxWidth: 0, maxHeight: 0 }),
        entry({ backend: "chrome", hardware: false }),
      ],
    }),
    "media.capabilities",
  );
  expect(verdict.status).toBe("warn");
  expect(verdict.message).toContain(
    "Video runs on the processor here: this computer has no hardware video encoder.",
  );
  expect(verdict.message).toContain("encode avc1.640028 on vaapi: processor, timed-out");
  expect(verdict.fix).toMatch(/graphics driver/);
});

it("a machine with no hardware backend at all is its expected path, not a warning", async () => {
  const verdict = await run(
    ports({ probeMs: 30, capabilities: [entry({ backend: "chrome", hardware: false })] }),
    "media.capabilities",
  );
  expect(verdict.status).toBe("ok");
  expect(verdict.message).toMatch(/^Video runs on the processor here/);
});

it("a probe slower than ready's 3 s warns", async () => {
  const verdict = await run(
    ports({ probeMs: 3_400, capabilities: [entry({})] }),
    "media.capabilities",
  );
  expect(verdict.status).toBe("warn");
});

it("the ranking cache is listed per GPU and driver, or said to be empty", async () => {
  const kept = await run(
    ports({
      probeMs: 10,
      capabilities: [],
      ranking: [
        {
          vendor: 0x10de,
          device: 0x2684,
          driver: "560.94",
          codec: "avc1",
          size: "1080p",
          winner: "nv",
        },
        { vendor: "unknown" },
      ],
    }),
    "media.ranking",
  );
  expect(kept.message).toBe("Encoder ranking:\n10de:2684 driver 560.94, avc1 1080p: nv");
  const none = await run(ports({ probeMs: 10, capabilities: [] }), "media.ranking");
  expect(none.message).toMatch(/^No encoder ranking kept/);
});

it("no ace-media is fine; a probe that fails or says nothing readable warns", async () => {
  const absent = { ...ports({}), binary: () => undefined };
  expect((await run(absent, "media.capabilities")).status).toBe("ok");
  const failed = await run(ports(new Error("spawn EACCES")), "media.capabilities");
  expect(failed).toMatchObject({
    status: "warn",
    message: "ace-media's probe failed: spawn EACCES",
  });
  expect((await run(ports("not json"), "media.ranking")).status).toBe("warn");
});
