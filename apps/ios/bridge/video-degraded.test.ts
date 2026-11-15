import { AppDevice, BrowserState, DeviceState, type ScreenState } from "@ace/protocol";
import { expect, test } from "vitest";
import { browserViewState } from "./browser-view.ts";
import { phoneDevicesView } from "./devices-view.ts";
import { phoneScreenSessions } from "./screen-view.ts";
import { plainPreview } from "./sheet-fixture.ts";

/*
 * A live view says one plain sentence when its source's video is degraded (docs/media/plan.md,
 * "Degraded, and the visible sentence"), and nothing otherwise: not while it plays on hardware,
 * and not before the source has chosen its steps.
 */

const onCpu = {
  steps: [{ step: "encode", backend: "cpu", hardware: false, readbacks: 1, uploads: 0 }],
  degraded: true,
  reason: "Video runs on the processor here: this computer has no hardware video encoder.",
};
const onHardware = {
  steps: [{ step: "encode", backend: "vt", hardware: true, readbacks: 0, uploads: 0 }],
  degraded: false,
};
/** NVIDIA's JPEG runs on the CPU because there is no hardware for it: expected, not degraded. */
const expectedCpu = {
  steps: [{ step: "jpeg-encode", backend: "cpu", hardware: false, readbacks: 1, uploads: 0 }],
  degraded: false,
  reason: "ignored while not degraded",
};
const cases = [
  ["degraded with a reason", onCpu, onCpu.reason],
  ["degraded without a reason", { ...onCpu, reason: undefined }, "Video runs on the processor here."],
  ["on hardware", onHardware, ""],
  ["on the CPU by design", expectedCpu, ""],
  ["not chosen yet", undefined, ""],
] as const;

const browser = (acceleration: unknown) =>
  browserViewState(
    BrowserState.parse({ threadId: "web", url: "https://example.com", closed: false, acceleration }),
    { preview: plainPreview, agentName: () => "Agent", navigation: undefined },
  ).degraded;

const screen = (acceleration: unknown) =>
  phoneScreenSessions(
    [
      {
        sessionId: "s-1",
        lifecycle: "live",
        controller: "none",
        mode: "background",
        secureInputAllowed: false,
        indicator: false,
        target: { kind: "app", bundleId: "com.apple.Safari" },
        permissions: { screenRecording: true, accessibility: true },
        ...(acceleration ? { acceleration } : {}),
      } as ScreenState,
    ],
    () => undefined,
  )[0]?.degraded;

const iphone = AppDevice.parse({
  id: "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b",
  name: "iPhone 17 Pro",
  platform: "ios",
  state: "booted",
});
const device = (acceleration: unknown) =>
  phoneDevicesView({
    snapshot: {
      connected: true,
      inventoryLoaded: true,
      devices: [iphone],
      states: [
        DeviceState.parse({
          device: iphone,
          enabled: true,
          lifecycle: "live",
          streamId: "s1",
          controller: "none",
          acceleration,
        }),
      ],
      issues: [],
      enabled: true,
    },
    closed: false,
    threadId: "thread-1",
    deviceId: iphone.id,
    query: "",
    platform: "all",
    now: 1_000,
    agent: () => undefined,
    previous: new Map(),
  }).device?.degraded;

for (const [name, acceleration, sentence] of cases) {
  test(`the browser's live view, ${name}, says ${sentence ? "the sentence" : "nothing"}`, () => {
    expect(browser(acceleration)).toBe(sentence);
  });
  test(`a Mac app's live view, ${name}, says ${sentence ? "the sentence" : "nothing"}`, () => {
    expect(screen(acceleration)).toBe(sentence);
  });
  test(`a device's screen, ${name}, says ${sentence ? "the sentence" : "nothing"}`, () => {
    expect(device(acceleration)).toBe(sentence);
  });
}
