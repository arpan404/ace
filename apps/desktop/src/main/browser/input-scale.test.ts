import { describe, expect, it } from "vitest";
import { agentEmulation } from "./placement.ts";
import { emulationScale, scaledInput } from "./input-scale.ts";

// Measured in Electron: with the page drawn at `scale`, Chromium dispatches CDP input at
// (x / scale, y / scale) in CSS pixels. This is where a dispatched point lands in the page.
const landsAt = (params: Record<string, unknown> | undefined, scale: number) => ({
  x: Number(params?.["x"]) / scale,
  y: Number(params?.["y"]) / scale,
});

describe("agent input on a device drawn fitted into the panel", () => {
  const panel = { x: 0, y: 0, width: 1095, height: 684 };
  const emulation = agentEmulation({ width: 1440, height: 900 }, panel, 1.316);
  const scale = emulationScale("Emulation.setDeviceMetricsOverride", emulation);

  it("a click at a CSS point lands on that point although the page is drawn smaller", () => {
    expect(scale).toBeLessThan(1);
    const press = { type: "mousePressed", x: 1080, y: 210, button: "left", clickCount: 1 };
    const sent = scaledInput("Input.dispatchMouseEvent", press, scale);
    expect(landsAt(sent, scale).x).toBeCloseTo(1080, 6);
    expect(landsAt(sent, scale).y).toBeCloseTo(210, 6);
    expect(sent).toMatchObject({ type: "mousePressed", button: "left", clickCount: 1 });
  });

  it("touch points land where they aim too", () => {
    const sent = scaledInput(
      "Input.dispatchTouchEvent",
      { type: "touchStart", touchPoints: [{ x: 400, y: 300, id: 1 }] },
      scale,
    );
    const [point] = (sent?.["touchPoints"] ?? []) as Record<string, unknown>[];
    expect(landsAt(point, scale)).toEqual({ x: expect.closeTo(400, 6), y: expect.closeTo(300, 6) });
    expect(point).toMatchObject({ id: 1 });
  });

  it("input is sent as it is once the page is drawn at full size again", () => {
    const cleared = emulationScale("Emulation.clearDeviceMetricsOverride", undefined);
    const press = { type: "mousePressed", x: 1080, y: 210 };
    expect(scaledInput("Input.dispatchMouseEvent", press, cleared)).toEqual(press);
  });

  it("an emulated device without a scale is drawn at full size", () => {
    expect(emulationScale("Emulation.setDeviceMetricsOverride", { width: 800, height: 600 })).toBe(
      1,
    );
  });

  it("key and text input carry no point and pass through", () => {
    const key = { type: "keyDown", key: "Enter" };
    expect(scaledInput("Input.dispatchKeyEvent", key, 0.5)).toEqual(key);
    expect(scaledInput("Input.insertText", { text: "x" }, 0.5)).toEqual({ text: "x" });
  });
});
