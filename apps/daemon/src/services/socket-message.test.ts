import { describe, expect, it } from "vitest";
import { decodeDeviceFrame, parseSocketMessage } from "./socket-message.ts";

describe("socket message decoding", () => {
  it.each([
    ["a client message", { type: "presence.update", threadId: null, inputAgeMs: 10 }],
    [
      "a plugin request",
      {
        type: "pluginRequest",
        requestId: "r1",
        request: { type: "plugins.prepare", repository: "fixture", ref: "main", name: "example" },
      },
    ],
    ["a browser control message", { type: "browser.tabs.list", requestId: "r1", threadId: "t1" }],
    [
      "a desktop browser event",
      {
        type: "browser.backend.event",
        backendId: "b1",
        sessionId: "s1",
        method: "ace.tabs.event",
        params: { tabId: "tab-1" },
      },
    ],
    ["a desktop wake notice", { type: "browser.backend.resumed" }],
    [
      "a user browser event",
      { type: "user_browser.event", event: { kind: "detached", tabId: 4, reason: "closed" } },
    ],
  ])("accepts %s from any message family", (_name, frame) => {
    expect(parseSocketMessage(frame)).toEqual(frame);
    expect(decodeDeviceFrame(frame)).toEqual({ kind: "message", message: frame });
  });

  it("drops fields a message family doesn't declare", () => {
    expect(parseSocketMessage({ type: "browser.backend.resumed", extra: 1 })).toEqual({
      type: "browser.backend.resumed",
    });
  });

  it.each([
    ["a known type with bad fields", { type: "browser.backend.drawable", drawable: "yes" }],
    ["an unknown type", { type: "nothing.here" }],
    ["no type", { requestId: "r1" }],
    ["a non-object", "browser.backend.resumed"],
    ["null", null],
  ])("rejects %s", (_name, frame) => {
    expect(() => parseSocketMessage(frame)).toThrow("Message does not match the protocol");
  });

  it("answers a signed-in device's unknown request with its request id", () => {
    expect(decodeDeviceFrame({ type: "nothing.here", requestId: "r9" })).toEqual({
      kind: "unsupported",
      requestId: "r9",
    });
    expect(decodeDeviceFrame({ type: "nothing.here" })).toEqual({ kind: "unsupported" });
  });

  it("answers a known request type with bad fields as invalid, keeping its request id", () => {
    expect(decodeDeviceFrame({ type: "browser.tabs.list", requestId: "r2", threadId: 4 })).toEqual({
      kind: "invalid",
      requestId: "r2",
    });
    expect(decodeDeviceFrame({ type: "browser.backend.drawable" })).toEqual({ kind: "invalid" });
  });

  it("treats a frame without a request shape as invalid", () => {
    expect(decodeDeviceFrame({ type: 4 })).toEqual({ kind: "invalid" });
    expect(decodeDeviceFrame({ type: "nothing.here", requestId: 4 })).toEqual({ kind: "invalid" });
    expect(decodeDeviceFrame([])).toEqual({ kind: "invalid" });
  });
});
