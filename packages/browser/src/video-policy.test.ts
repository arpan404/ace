import { describe, expect, it } from "vitest";
import type { BrowserCaptureViewport } from "@ace/protocol";
import { planVideo, maxEncodes, type VideoViewer } from "./video-policy.ts";
import type { CaptureLoad } from "./capture-policy.ts";

const page = { width: 1280, height: 800, scale: 2, codecs: ["avc1.42E033", "vp8"] };
const viewer = (
  id: string,
  viewport: Partial<BrowserCaptureViewport> = {},
  load: CaptureLoad = 0,
  codecs = ["avc1.42E033"],
): VideoViewer => ({
  id,
  viewport: { width: 1280, height: 800, devicePixelRatio: 1, ...viewport },
  codecs,
  load,
});

describe("video encodes for a tab's viewers", () => {
  it("a viewer gets the page at its screen's pixels, capped by what the tab renders", () => {
    const plan = planVideo(page, [viewer("retina", { devicePixelRatio: 2 })]);
    expect(plan.encodes).toMatchObject([{ width: 2560, height: 1600, fps: 30 }]);
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

  it("a viewer that falls behind gets its own slower encode at the same size", () => {
    const plan = planVideo(page, [viewer("keeping-up"), viewer("behind", {}, 1)]);
    const fast = plan.encodes.find((encode) => encode.key === plan.viewers.get("keeping-up"));
    const slow = plan.encodes.find((encode) => encode.key === plan.viewers.get("behind"));
    expect(fast?.fps).toBe(30);
    expect(slow?.fps).toBe(15);
    expect([slow?.width, slow?.height]).toEqual([fast?.width, fast?.height]);
    expect(slow?.bitrate).toBeLessThan(fast?.bitrate ?? 0);
  });

  it("each viewer gets the first codec it prefers that the encoder has", () => {
    const plan = planVideo({ ...page, codecs: ["vp8"] }, [
      viewer("both", {}, 0, ["avc1.42E033", "vp8"]),
      viewer("h264-only", {}, 0, ["avc1.42E033"]),
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
    const viewers = [viewer("a"), viewer("b", { width: 640, height: 400 }), viewer("c", {}, 2)];
    const forward = planVideo(page, viewers);
    const backward = planVideo(page, viewers.toReversed());
    expect(backward.encodes).toEqual(forward.encodes);
    expect([...backward.viewers].toSorted()).toEqual([...forward.viewers].toSorted());
  });
});
