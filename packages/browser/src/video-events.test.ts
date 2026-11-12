import { expect, test } from "vitest";
import type { CaptureEvents } from "./backend.ts";
import { deliverVideoEvent, VideoEncoderEvent } from "./video-events.ts";

test("why the encoder ended a capture reaches the capture's listener", () => {
  const reasons: (string | undefined)[] = [];
  const events: CaptureEvents = {
    chunk: () => {},
    failed: () => {},
    ended: (reason) => void reasons.push(reason),
  };
  const captures = new Map([
    ["capture-1", events],
    ["capture-2", events],
  ]);
  const ended = (raw: unknown) =>
    deliverVideoEvent(captures, VideoEncoderEvent.parse(raw), undefined);
  ended({ t: "ended", capture: "capture-1", reason: "The tab capture sent no picture" });
  // An encoder that gives no reason still ends the capture.
  ended({ t: "ended", capture: "capture-2" });
  expect(reasons).toEqual(["The tab capture sent no picture", undefined]);
  // Each capture ends once.
  ended({ t: "ended", capture: "capture-1", reason: "again" });
  expect(reasons).toHaveLength(2);
});
