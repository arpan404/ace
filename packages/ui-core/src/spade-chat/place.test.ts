import { describe, expect, test } from "vitest";
import {
  parseSpadeEvents,
  spadeApprovalSentence,
  spadeCallLine,
  spadeJobEndLine,
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

test("a call reads as what it did, or why it didn't run", () => {
  expect(spadeCallLine("web_search", "done")).toBe("Searched the web");
  expect(spadeCallLine("send_email", "declined")).toBe("You declined: send an email");
  expect(spadeCallLine("ace__thread_start", "running")).toBe("Using thread start");
  expect(spadeCallLine("web_fetch", "skipped")).toBe("Didn't read a web page");
  expect(spadeApprovalSentence("ace_thread_send")).toBe(
    "Spade wants to send a message to a thread.",
  );
  expect(spadeCallLine("ace_new_thing", "done")).toBe("Used new thing");
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
