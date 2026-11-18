import { describe, expect, it } from "vitest";
import { SpikePerfProbe } from "./spike-perf-probe.ts";

const origin = "http://127.0.0.1:9841";
const post = (probe: SpikePerfProbe, body: unknown) =>
  probe.handle(
    new Request(`${origin}/perf-probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const read = async (probe: SpikePerfProbe, run: string) => {
  const reply = await probe.handle(
    new Request(`${origin}/perf-probe?run=${encodeURIComponent(run)}`),
  );
  if (!reply) throw new Error("the probe left /perf-probe unanswered");
  expect(reply.status).toBe(200);
  return (await reply.json()).text;
};

describe("spike perf probe", () => {
  it("answers a run with the newest numbers its app posted", async () => {
    const probe = new SpikePerfProbe();
    await post(probe, { run: "launch-1", text: "opens=1.0" });
    await post(probe, { run: "launch-1", text: "opens=2.0;open.readyMs=310" });
    expect(await read(probe, "launch-1")).toBe("opens=2.0;open.readyMs=310");
  });

  it("never answers one launch with another launch's numbers", async () => {
    const probe = new SpikePerfProbe();
    await post(probe, { run: "launch-1", text: "pages.older=25.0" });
    expect(await read(probe, "launch-2")).toBeNull();
    await post(probe, { run: "launch-2", text: "pages.older=1.0" });
    expect(await read(probe, "launch-1")).toBe("pages.older=25.0");
    expect(await read(probe, "launch-2")).toBe("pages.older=1.0");
  });

  it("keeps only the latest runs", async () => {
    const probe = new SpikePerfProbe(2);
    for (const run of ["a", "b", "c"]) await post(probe, { run, text: `run=${run}` });
    expect(await read(probe, "a")).toBeNull();
    expect(await read(probe, "c")).toBe("run=c");
  });

  it("refuses a malformed post and keeps what it held", async () => {
    const probe = new SpikePerfProbe();
    await post(probe, { run: "launch-1", text: "opens=1.0" });
    expect((await post(probe, { run: "", text: "opens=9.0" }))?.status).toBe(400);
    expect((await post(probe, { text: "opens=9.0" }))?.status).toBe(400);
    expect(await read(probe, "launch-1")).toBe("opens=1.0");
  });

  it("leaves other paths to the rest of the fixture", async () => {
    expect(await new SpikePerfProbe().handle(new Request(`${origin}/health`))).toBeUndefined();
  });
});
