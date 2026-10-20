import { describe, expect, it } from "vitest";
import type { BrowserCaptureViewport } from "@ace/protocol";
import { planVideo, maxEncodes, minBitrate, type VideoViewer } from "./video-policy.ts";

const page = { width: 1280, height: 800, scale: 2, codecs: ["avc1.42E033", "vp8"] };
const viewer = (
  id: string,
  viewport: Partial<BrowserCaptureViewport> = {},
  link = 20_000_000,
  codecs = ["avc1.42E033"],
): VideoViewer => ({
  id,
  viewport: { width: 1280, height: 800, devicePixelRatio: 1, ...viewport },
  codecs,
  link,
});

describe("video encodes for a tab's viewers", () => {
  it("a viewer gets the page at its screen's pixels, capped by what the tab renders", () => {
    const plan = planVideo(page, [viewer("retina", { devicePixelRatio: 2 })]);
    expect(plan.encodes).toMatchObject([{ width: 2560, height: 1600, fps: 60 }]);
    const sharper = planVideo(page, [viewer("phone", { devicePixelRatio: 3 })]);
    // The tab renders at 2x: a DPR 3 screen can't get more than that.
    expect(sharper.encodes).toMatchObject([{ width: 2560, height: 1600 }]);
  });

  it("a pane showing the page smaller gets a smaller picture, with even sides", () => {
    const plan = planVideo(page, [viewer("pip", { width: 333, height: 400 })]);
    const [encode] = plan.encodes;
    expect(encode?.width).toBe(334);
    expect(encode?.height).toBe(208);
  });

  it("viewers of similar size share one encode; very different sizes get their own", () => {
    const plan = planVideo(page, [
      viewer("laptop", { devicePixelRatio: 2 }),
      viewer("desktop", { width: 1180, height: 740, devicePixelRatio: 2 }),
      viewer("small", { width: 640, height: 400 }),
    ]);
    expect(plan.encodes).toHaveLength(2);
    expect(plan.viewers.get("laptop")).toBe(plan.viewers.get("desktop"));
    expect(plan.viewers.get("small")).not.toBe(plan.viewers.get("laptop"));
  });

  it("a slow link costs bit rate, never frames", () => {
    const fast = planVideo(page, [viewer("fiber")]).encodes[0];
    const slow = planVideo(page, [viewer("phone", {}, 2_000_000)]).encodes[0];
    expect(fast?.fps).toBe(60);
    expect(slow?.fps).toBe(60);
    expect(slow?.bitrate).toBe(2_000_000);
    expect(fast?.bitrate).toBeGreaterThan(2_000_000);
    expect(planVideo(page, [viewer("dial-up", {}, 1_000)]).encodes[0]?.bitrate).toBe(minBitrate);
  });

  it("a shared encode runs at the slowest member's link, under the same key", () => {
    const alone = planVideo(page, [viewer("fiber")]);
    const shared = planVideo(page, [viewer("fiber"), viewer("phone", {}, 3_000_000)]);
    expect(shared.encodes).toHaveLength(1);
    expect(shared.encodes[0]?.bitrate).toBe(3_000_000);
    // A new bit rate is applied in place, not as a new encoder.
    expect(shared.encodes[0]?.key).toBe(alone.encodes[0]?.key);
  });

  it("a scaled-down viewer gets a smaller encode while the capture stays full size", () => {
    const plan = planVideo(page, [{ ...viewer("thin", { devicePixelRatio: 2 }), scale: 0.5 }]);
    expect(plan.encodes).toMatchObject([{ width: 1280, height: 800 }]);
    expect(plan.capture).toEqual({ width: 2560, height: 1600 });
  });

  it("each viewer gets the first codec it prefers that the encoder has", () => {
    const plan = planVideo({ ...page, codecs: ["vp8"] }, [
      viewer("both", {}, undefined, ["avc1.42E033", "vp8"]),
      viewer("h264-only", {}, undefined, ["avc1.42E033"]),
    ]);
    expect(plan.encodes.map((encode) => encode.codec)).toEqual(["vp8"]);
    expect(plan.viewers.has("h264-only")).toBe(false);
  });

  it("a viewer showing the native page takes no video", () => {
    expect(planVideo(page, [viewer("desktop", { nativeShown: true })]).encodes).toEqual([]);
  });

  it("more viewer sizes than encoders join the nearest encode", () => {
    const sizes = [1280, 900, 640, 400, 200, 150];
    const plan = planVideo(
      page,
      sizes.map((width) => viewer(`w${width}`, { width, height: width * 0.625 })),
    );
    expect(plan.encodes).toHaveLength(maxEncodes);
    expect(plan.viewers.size).toBe(sizes.length);
  });

  it("the plan is the same whatever order viewers come in", () => {
    const viewers = [
      viewer("a"),
      viewer("b", { width: 640, height: 400 }),
      viewer("c", {}, 4_000_000),
    ];
    const forward = planVideo(page, viewers);
    const backward = planVideo(page, viewers.toReversed());
    expect(backward.encodes).toEqual(forward.encodes);
    expect([...backward.viewers].toSorted()).toEqual([...forward.viewers].toSorted());
  });
});
