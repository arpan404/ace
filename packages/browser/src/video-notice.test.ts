import { expect, test } from "vitest";
import { encoderRecovering } from "./live-video.ts";
import { videoNotice } from "./video-notice.ts";

const recovering = { code: "recovering", reason: encoderRecovering };

test("a view whose codecs all failed says the encoder is recovering, in place of a playing view's silence or a stop", () => {
  expect(videoNotice(undefined, true)).toEqual(recovering);
  expect(
    videoNotice(
      { code: "stopped", reason: "Live video stopped for a moment. It comes back by itself." },
      true,
    ),
  ).toEqual(recovering);
  expect(
    videoNotice(
      { code: "starting", reason: "Live video is starting. It shows in a moment." },
      true,
    ),
  ).toEqual(recovering);
});

test("why the connection or ace-media can't deliver comes first: the encoder's recovery waits behind it", () => {
  for (const code of ["refused", "unavailable", "failed", "update", "timeout"]) {
    const blocked = { code, reason: "Something between here and ace-media." };
    expect(videoNotice(blocked, true)).toEqual(blocked);
  }
});

test("once the encoder runs again the view says what it said before, or nothing", () => {
  expect(videoNotice(undefined, false)).toBeUndefined();
  const stopped = {
    code: "stopped",
    reason: "Live video stopped for a moment. It comes back by itself.",
  };
  expect(videoNotice(stopped, false)).toEqual(stopped);
});
