import { describe, expect, test } from "vitest";
import {
  parseSpadeConversations,
  parseSpadeModels,
  spadeCallLine,
  spadeRowWorking,
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

describe("the conversation list", () => {
  test("a row works while Spade answers or a background job is out, and only then", () => {
    const rows = parseSpadeConversations(
      JSON.stringify([
        { id: "a", title: "Trip", updated_at: 3, answering: true, jobs: 0 },
        { id: "b", title: "Mail", updated_at: 2, answering: false, jobs: 2 },
        { id: "c", title: null, updated_at: 1, answering: false, jobs: 0 },
      ]),
    );
    expect(rows?.map((row) => [row.id, row.title, spadeRowWorking(row)])).toEqual([
      ["a", "Trip", true],
      ["b", "Mail", true],
      ["c", "", false],
    ]);
  });

  test("a row it can't read is left out; a body that isn't a list reads as nothing", () => {
    expect(parseSpadeConversations(JSON.stringify([{ title: "no id" }, { id: "x" }]))).toEqual([
      { id: "x", title: "", updatedAt: 0, answering: false, jobs: 0 },
    ]);
    expect(parseSpadeConversations("{}")).toBeUndefined();
  });
});

test("endpoints say whether each needs a key and has one, without any key itself", () => {
  const models = parseSpadeModels(
    JSON.stringify({
      endpoints: [
        {
          id: "openrouter",
          name: "OpenRouter",
          format: "openai",
          needs_key: true,
          key_set: false,
          models: [{ id: "m1", name: "Model one" }],
        },
        { id: "local", needs_key: false, key_set: false, models: [] },
      ],
      roles: { main: "m1", fast: null },
      keychain: true,
    }),
  );
  expect(models).toEqual({
    endpoints: [
      {
        id: "openrouter",
        name: "OpenRouter",
        needsKey: true,
        keySet: false,
        models: [{ id: "m1", name: "Model one" }],
      },
      { id: "local", name: "local", needsKey: false, keySet: false, models: [] },
    ],
    roles: { main: "m1" },
    keychain: true,
  });
});

test("a call reads as what it did, or why it didn't run", () => {
  expect(spadeCallLine("web_search", "done")).toBe("Searched the web");
  expect(spadeCallLine("send_email", "declined")).toBe("You declined: send an email");
  expect(spadeCallLine("ace__thread_start", "running")).toBe("Using thread start");
  expect(spadeCallLine("web_fetch", "skipped")).toBe("Didn't read a web page");
});
