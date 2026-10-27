import { expect, test } from "vitest";
import { StreamMeter, streamDetails, streamSummary } from "./stream-stats.ts";

test("the stream's subtitle counts the last second's frames and their delay on one machine", () => {
  const meter = new StreamMeter({ sameClock: true });
  for (let at = 0; at <= 1500; at += 25) meter.add({ capturedAt: at - 30, shownAt: at });
  expect(streamSummary(meter.read(1500))).toEqual(["H.264", "40 fps", "30 ms"]);
});

test("the subtitle leaves out what it can't know: the rate in the first second, a remote delay", () => {
  const remote = new StreamMeter({ sameClock: false });
  remote.add({ capturedAt: 0, shownAt: 100 });
  expect(streamSummary(remote.read(200))).toEqual(["H.264"]);
  expect(streamSummary(remote.read(5000))).toEqual(["H.264"]);
  expect(streamSummary(new StreamMeter({ sameClock: true }).read(0))).toEqual([]);
});

test("a still Simulator's five re-sends a second read as a still screen, not a 5 fps stream", () => {
  const meter = new StreamMeter({ sameClock: false });
  for (let at = 0; at <= 2000; at += 200) {
    meter.receive(at, 600);
    meter.add({ capturedAt: at, shownAt: at });
  }
  expect(streamSummary(meter.read(2000))).toEqual(["H.264", "still"]);
  // A larger still screen (an iPhone 18 Pro Max) re-sends heavier pictures, and a clock tick
  // adds a couple more in a second: still a still screen.
  const larger = new StreamMeter({ sameClock: false });
  for (const at of [0, 200, 400, 600, 800, 1000, 1100, 1200, 1300, 1400, 1600, 1800, 2000]) {
    larger.receive(at, 4400);
    larger.add({ capturedAt: at, shownAt: at });
  }
  expect(streamSummary(larger.read(2000))).toEqual(["H.264", "still"]);
  // The same rate of full pictures is a struggling stream, and says its rate.
  const struggling = new StreamMeter({ sameClock: false });
  for (let at = 0; at <= 2000; at += 200) {
    struggling.receive(at, 40_000);
    struggling.add({ capturedAt: at, shownAt: at });
  }
  expect(streamSummary(struggling.read(2000))).toEqual(["H.264", "5 fps"]);
});

test("the stream stats show pictures that arrived but weren't drawn, the longest stall and keyframes asked", () => {
  const meter = new StreamMeter({ sameClock: false });
  // 60 pictures arrive in the last second; a stall left 400 ms without a drawn frame.
  for (let index = 0; index < 60; index++) meter.receive(1001 + index * 16, 12_500);
  for (let at = 0; at <= 1000; at += 20) meter.add({ capturedAt: at, shownAt: at });
  for (let at = 1400; at <= 2000; at += 50) meter.add({ capturedAt: at, shownAt: at });
  meter.keyframeAsked(1100);
  meter.decoder("default", "EncodingError");
  expect(streamDetails(meter.read(2000))).toEqual([
    "Received 60/s · drawn 13/s",
    "6.0 Mbit/s",
    "Longest stall 400 ms (5 s)",
    "Keyframes asked 1 (5 s)",
    "Decoder: browser default (hardware failed: EncodingError)",
  ]);
});
