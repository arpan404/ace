import { expect, it } from "vitest";
import { liveVideoSentence } from "./live-video-status.ts";

it("a stopped live view says why in one sentence, and nothing while it plays", () => {
  expect(
    liveVideoSentence({ status: "retrying", reason: "ace-media stopped and is starting again" }),
  ).toBe("ace-media stopped and is starting again.");
  expect(liveVideoSentence({ status: "unavailable", reason: "No encoder works here." })).toBe(
    "No encoder works here.",
  );
  expect(liveVideoSentence(undefined)).toBeUndefined();
});
