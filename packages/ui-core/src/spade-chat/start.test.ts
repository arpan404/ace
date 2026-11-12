import { ClientError } from "@ace/client";
import { expect, test } from "vitest";
import {
  SpadeRequestError,
  spadeStart,
  spadeStartWords,
  spadeUnconfirmedNote,
  type SpadeStartLink,
} from "./index.ts";

/*
 * Starting a conversation when its answer may be lost: Spade has no key to say "this start",
 * so a lost answer is settled by what Spade lists afterwards, and only when that is certain.
 */

interface Stored {
  id: string;
  updated_at: number;
  first: string;
  /** Images on the first message. */
  images?: number;
}

const image = (index: number) => ({ sha256: index.toString(16).padStart(64, "0") });

/** A Spade holding `conversations`; `post` decides how the start goes. */
function spade(conversations: Stored[], post: (stored: Stored[]) => Promise<string>, back = true) {
  const asked: string[] = [];
  const link: SpadeStartLink = {
    read: async (path) => {
      asked.push(`GET ${path}`);
      if (path === "/v1/conversations")
        return JSON.stringify(conversations.toSorted((a, b) => b.updated_at - a.updated_at));
      const id = /^\/v1\/conversations\/([^/]+)\/events/.exec(path)?.[1];
      const found = conversations.find((row) => row.id === id);
      const images = Array.from({ length: found?.images ?? 0 }, (_, index) => image(index));
      return JSON.stringify(
        found
          ? [{ seq: 1, at: 0, event: { type: "user_message", text: found.first, images } }]
          : [],
      );
    },
    post: async (path) => {
      asked.push(`POST ${path}`);
      return post(conversations);
    },
    back: async () => back,
  };
  return { link, asked };
}

const lost = new ClientError("offline", "offline");
const words = (text: string, images = 0) => ({ text, images });
const earlier = { id: "old", updated_at: 1, first: "What's on today?" };
/** Spade makes `made` from the start, then its answer is lost. */
const makesThenLoses =
  (...made: Stored[]) =>
  async (stored: Stored[]) => {
    stored.push(...made);
    throw lost;
  };

test("a start that answers opens its conversation", async () => {
  const { link } = spade([], async () => '{"id":"c1"}');
  expect(await spadeStart(link, { text: "Hi" }, words("Hi"))).toEqual({
    kind: "started",
    id: "c1",
  });
});

test("a start whose answer was lost opens the conversation Spade made from it, not an older one", async () => {
  const { link } = spade(
    [earlier],
    makesThenLoses({ id: "new", updated_at: 2, first: "What's on today?" }),
  );
  expect(await spadeStart(link, { text: "What's on today?" }, words("What's on today?"))).toEqual({
    kind: "started",
    id: "new",
  });
});

test.each([
  [
    "two new conversations open with the same words",
    words("Hi"),
    [
      { id: "a", updated_at: 2, first: "Hi" },
      { id: "b", updated_at: 3, first: "Hi" },
    ],
  ],
  [
    "this start carried images, which can't be told apart",
    words("Look at this", 1),
    [{ id: "a", updated_at: 2, first: "Look at this", images: 1 }],
  ],
])("a lost start is unknown, never claimed, when %s", async (_why, message, made) => {
  const { link } = spade([], makesThenLoses(...made));
  expect(await spadeStart(link, { text: message.text }, message)).toEqual({ kind: "unknown" });
});

test("a new conversation with the same words but images is someone else's", async () => {
  const { link } = spade([], makesThenLoses({ id: "a", updated_at: 2, first: "Hi", images: 2 }));
  await expect(spadeStart(link, { text: "Hi" }, words("Hi"))).rejects.toThrow(SpadeRequestError);
});

test("a start whose answer was lost before Spade made anything comes back to be sent again", async () => {
  const { link } = spade([earlier], async () => {
    throw lost;
  });
  await expect(spadeStart(link, { text: "Hi" }, words("Hi"))).rejects.toThrow(SpadeRequestError);
});

test("a start whose answer was lost, with Spade out of reach to ask, is unknown", async () => {
  const { link, asked } = spade(
    [],
    async () => {
      throw new ClientError("timeout", "timeout");
    },
    false,
  );
  expect(await spadeStart(link, { text: "Hi" }, words("Hi"))).toEqual({ kind: "unknown" });
  expect(asked.filter((call) => call.startsWith("GET"))).toEqual(["GET /v1/conversations"]);
});

test("a start Spade refused comes back at once, without looking for it", async () => {
  const { link, asked } = spade([], async () => {
    throw new SpadeRequestError("Today's spending cap is reached.", 402);
  });
  await expect(spadeStart(link, { text: "Hi" }, words("Hi"))).rejects.toThrow("spending cap");
  expect(asked).toEqual(["GET /v1/conversations", "POST /v1/conversations"]);
});

test("the composer clears a start's words only once it started, and keeps an unknown one with a note", () => {
  expect(spadeStartWords("started")).toEqual({ keep: false, note: undefined });
  expect(spadeStartWords("refused")).toEqual({ keep: true, note: undefined });
  expect(spadeStartWords("unknown")).toEqual({ keep: true, note: spadeUnconfirmedNote });
});
