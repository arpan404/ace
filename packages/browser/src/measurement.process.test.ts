import { describe, expect, it } from "vitest";
import { InteractionMeasurement, McpScope } from "@ace/protocol";
import { CredentialRegistry, ToolRegistry, nodeScheduler } from "@ace/mcp-server";
import { z } from "zod";
import { browserToolkit } from "./index.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

if (!executablePath)
  console.warn("Skipping interaction measurements: no isolated Chromium executable is available.");
const scene = (
  stall: number,
) => `(()=>{document.body.innerHTML='<button id="start">Animate</button><div id="box" style="width:80px;height:80px;background:red"></div>';
document.querySelector('#start').onclick=()=>{
 let frame=0;
 function animate(){
  if(frame===15&&${stall}>0){const end=performance.now()+${stall};while(performance.now()<end){}}
  document.querySelector('#box').style.transform='translateX('+frame*3+'px)';
  if(++frame<50)requestAnimationFrame(animate);
 }
 requestAnimationFrame(animate);
};return true})()`;

describe.skipIf(!executablePath)("browser interaction measurements", () => {
  it("reports a main-thread stall and its missed compositor updates", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(scene(120));
    const snapshot = await f.execute({ action: "snapshot" });
    const measurement = InteractionMeasurement.parse(
      await f.execute({
        action: "measure_interaction",
        interaction: { action: "click", ref: ref(snapshot, "Animate") },
        observeMs: 1600,
        filmstrip: false,
      }),
    );
    expect(measurement.source).toBe("browser-trace");
    expect(measurement.longTasks?.some((task) => task.durationMs >= 100)).toBe(true);
    expect(measurement.hitches.some((hitch) => hitch.durationMs >= 100)).toBe(true);
    expect(measurement.verdict).toBe("janky");
    expect(measurement.frames).toBeGreaterThan(20);
    expect(await f.evaluate("document.querySelector('#box').style.transform")).toMatch(
      /^translateX\(\d+px\)$/,
    );
  }, 60_000);
  it("measures a smooth animation and returns one bounded JPEG filmstrip", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(scene(0));
    const snapshot = await f.execute({ action: "snapshot" });
    const measurement = InteractionMeasurement.parse(
      await f.execute({
        action: "measure_interaction",
        interaction: { action: "click", ref: ref(snapshot, "Animate") },
        observeMs: 1600,
      }),
    );
    expect(measurement.verdict).toBe("smooth");
    expect(measurement.longTasks).toEqual([]);
    expect(measurement.refreshHz).toBeGreaterThanOrEqual(50);
    expect(measurement.refreshHz).toBeLessThanOrEqual(130);
    expect(measurement.latencyMs).toBeDefined();
    expect(measurement.filmstrip).toBeDefined();
    const data = measurement.filmstrip?.data ?? "";
    expect(Buffer.from(data, "base64").subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    expect(data.length).toBeLessThanOrEqual(1024 * 1024);
  }, 60_000);
  it("allows shared observations during human control and blocks measured agent input", async () => {
    const f = await fixture();
    await f.navigate();
    f.service.takeover("thread", "human");
    const observed = InteractionMeasurement.parse(
      await f.execute({
        action: "measure_interaction",
        observeMs: 300,
        repeat: 2,
        filmstrip: false,
      }),
    );
    expect(observed.repeat?.runs).toHaveLength(2);
    await expect(
      f.execute({
        action: "measure_interaction",
        interaction: { action: "scroll", x: 0, y: 100 },
        observeMs: 300,
        filmstrip: false,
      }),
    ).rejects.toMatchObject({ code: "human_controlled" });
    f.service.takeover("thread", "human", "private");
    await expect(
      f.execute({ action: "measure_interaction", observeMs: 300, filmstrip: false }),
    ).rejects.toMatchObject({ code: "human_private" });
  }, 60_000);
});

it("measurement MCP validates bounded inputs and returns numbers plus an image", async () => {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  const model = InteractionMeasurement.parse({
    source: "browser-trace",
    target: { kind: "browser-tab", threadId: "thread" },
    refreshHz: 60,
    windowMs: 300,
    frames: 0,
    hitches: [],
    verdict: "no_change",
    confidence: "low",
    notes: [],
    filmstrip: {
      type: "image",
      mimeType: "image/jpeg",
      data: Buffer.from([255, 216, 255, 217]).toString("base64"),
    },
  });
  browserToolkit({
    execute: async () => model,
    screenshot: async () => Buffer.from("unused"),
  }).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "measurement",
      threadId: "thread",
      agentId: "root",
      capabilities: ["browser"],
    }),
    new AbortController().signal,
  );
  try {
    const call = (args: unknown) =>
      registry.call(
        "ace_browser_measure_interaction",
        args,
        lease.principal,
        new AbortController().signal,
      );
    const response = z
      .object({ content: z.array(z.looseObject({ type: z.string() })) })
      .parse(await call({ observeMs: 300 }));
    expect(response.content.map((part) => part.type)).toEqual(["text", "image"]);
    for (const args of [{ observeMs: 10_001 }, { repeat: 6 }, { observeMs: 10_000, repeat: 3 }])
      expect(await call(args)).toHaveProperty("isError", true);
    expect(registry.action("ace_browser_measure_interaction", { observeMs: 300 })).toMatchObject({
      riskClass: "read-only",
      access: "read",
    });
    expect(
      registry.action("ace_browser_measure_interaction", {
        interaction: { action: "scroll", x: 0, y: 10 },
      }),
    ).toMatchObject({ riskClass: "external-effect", access: "write" });
    expect(
      registry.action("ace_browser_measure_interaction", { tabId: "selected-tab" }),
    ).toMatchObject({ riskClass: "external-effect", access: "write" });
  } finally {
    credentials.close();
  }
});
