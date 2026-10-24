import "./test-host.ts";
import { ScreenClientError } from "@ace/client/screen-stream";
import { expect, test } from "vitest";
import { screenFailure } from "./native-screen.ts";

test("a background window's unconfirmed input reaches the phone with its code", () => {
  const refused = new ScreenClientError({
    type: "screen.result",
    requestId: "r1",
    ok: false,
    errorCode: "delivery_unconfirmed",
    error: "Input was dispatched to the selected window but its effect is unconfirmed.",
  });
  expect(screenFailure(refused)).toEqual({
    message: "Input was dispatched to the selected window but its effect is unconfirmed.",
    code: "delivery_unconfirmed",
  });
});

test("a failure the daemon gave no code for reaches the phone as words only", () => {
  expect(screenFailure(new Error("Screen connection closed"))).toEqual({
    message: "Screen connection closed",
  });
});
