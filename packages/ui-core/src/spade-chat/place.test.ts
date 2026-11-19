import { describe, expect, test } from "vitest";
import {
  parseSpadeEvents,
  spadeApprovalSentence,
  spadeFailureSentence,
  spadeJobEndLine,
  spadeSetupSentence,
  spadeStateLine,
} from "./index.ts";

describe("what the Spade place says about Spade", () => {
  test("with the setting off it is off and offers Turn on", () => {
    expect(spadeStateLine({ state: "off" }, false)).toEqual({
      sentence: "Spade is off.",
      ready: false,
      canTurnOn: true,
    });
  });

  test("on but not installed, it says why and doesn't offer Turn on", () => {
    const line = spadeStateLine({ state: "off", reason: "Spade isn't installed." }, true);
    expect(line).toEqual({ sentence: "Spade isn't installed.", ready: false, canTurnOn: false });
  });

  test("starting, running and failed each read in words, a failure with its reason", () => {
    expect(spadeStateLine({ state: "starting" }, true).sentence).toBe("Spade is starting.");
    expect(spadeStateLine({ state: "ready", version: "0.1.0" }, true)).toMatchObject({
      sentence: "Spade is running.",
      ready: true,
    });
    expect(
      spadeStateLine({ state: "failed", reason: "It exited with code 1." }, true).sentence,
    ).toBe("Spade stopped. It exited with code 1.");
  });
});

const waiting = (platform: string) =>
  spadeSetupSentence({
    state: "ready",
    version: "0.1.0",
    setup: { reason: "waiting for the keychain", platform },
  });

test("while Spade waits for the keychain, the person is told what to look for on its platform", () => {
  expect(waiting("darwin")).toBe(
    "Spade is waiting for the keychain. Look for a macOS prompt and choose Always Allow.",
  );
  expect(waiting("linux")).toContain("keyring");
  expect(waiting("win32")).toContain("Windows");
  expect(waiting("freebsd")).toContain("waiting for the keychain");
  expect(spadeSetupSentence({ state: "ready", version: "0.1.0" })).toBeUndefined();
  expect(spadeSetupSentence({ state: "starting" })).toBeUndefined();
});

test("an approval reads in the tool's plain words, even for a tool it doesn't know", () => {
  expect(spadeApprovalSentence("ace_thread_send")).toBe(
    "Spade wants to send a message to a thread.",
  );
  expect(spadeApprovalSentence("ace_new_thing")).toBe("Spade wants to use new thing.");
});

test("an events page keeps every event it can read, in order", () => {
  const page = parseSpadeEvents(
    JSON.stringify([
      { seq: 1, at: 5, event: { type: "user_message", text: "Hi" } },
      { at: 6, event: { type: "renamed", title: "x" } },
      { seq: 3, at: 7, event: { type: "something_new" } },
    ]),
  );
  expect(page?.map((stored) => [stored.seq, stored.event.type])).toEqual([
    [1, "user_message"],
    [3, "unknown"],
  ]);
});

test("a background job's end reads in words, agents' work as the agents'", () => {
  expect(spadeJobEndLine("delegate", "done")).toBe("The agents finished");
  expect(spadeJobEndLine("research", "failed")).toBe("Couldn't research in the background");
  expect(spadeJobEndLine("delegate", "stopped")).toBe("Stopped the agents");
  expect(spadeJobEndLine("research", "stopped")).toBe("Stopped researching");
});

describe("a failed reply's sentence", () => {
  test("says what failed, naming the endpoint as the person named it, and what to do", () => {
    expect(spadeFailureSentence("unreachable", "OpenCode Go")).toBe(
      "Couldn't reach OpenCode Go. Check it's running and online, then try again.",
    );
    expect(spadeFailureSentence("key", "OpenCode Go")).toBe(
      "OpenCode Go refused the key. Replace it in Settings › Models, then try again.",
    );
    expect(spadeFailureSentence("rate_limited", "OpenCode Go")).toBe(
      "OpenCode Go is limiting requests right now. Wait a moment, then try again.",
    );
    expect(spadeFailureSentence("model", "OpenCode Go")).toBe(
      "The model on OpenCode Go failed to answer.",
    );
    expect(spadeFailureSentence("no_model", undefined)).toBe(
      "There's no model set up to answer. Set one up, then try again.",
    );
  });

  test("an endpoint this app doesn't know reads as the endpoint", () => {
    expect(spadeFailureSentence("key", undefined)).toMatch(/^The endpoint refused the key\./);
    expect(spadeFailureSentence("unreachable", undefined)).toMatch(
      /^Couldn't reach the endpoint\./,
    );
  });
});
