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
 * Starting a conversation when its answer may be lost. Each start carries its own client key: a
 * Spade that keeps keys finds the start by it, or answers the same start again with the
 * conversation it made. A Spade older than keys lists none, and its lost starts are settled by
 * what it lists, only when that is certain.
 */

interface Stored {
  id: string;
  updated_at: number;
  first: string;
  /** Images on the first message. */
  images?: number;
  /** The start's key, listed as Spade lists it: absent from a Spade older than keys. */
  client_key?: string | null;
}

const image = (index: number) => ({ sha256: index.toString(16).padStart(64, "0") });

/** A Spade holding `conversations`; `post` decides how each start goes. */
function spade(
  conversations: Stored[],
  post: (stored: Stored[], body: Record<string, unknown>) => Promise<string>,
  back = true,
) {
  const asked: string[] = [];
  const posted: Record<string, unknown>[] = [];
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
    post: async (path, body) => {
      asked.push(`POST ${path}`);
      const sent = body as Record<string, unknown>;
      posted.push(sent);
      return post(conversations, sent);
    },
    back: async () => back,
  };
  return { link, asked, posted };
}

const key = "5d0c8f6e-1b2a-4c3d-9e8f-7a6b5c4d3e2f";

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
  expect(await spadeStart(link, { text: "Hi" }, words("Hi"), key)).toEqual({
    kind: "started",
    id: "c1",
  });
});

test("on a Spade older than keys, a lost start whose words show up is unknown, never claimed", async () => {
  // It may be this start's, or an identical one from another device: nothing tells them apart.
  const { link } = spade(
    [earlier],
    makesThenLoses({ id: "new", updated_at: 2, first: "What's on today?" }),
  );
  expect(
    await spadeStart(link, { text: "What's on today?" }, words("What's on today?"), key),
  ).toEqual({ kind: "unknown" });
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
])(
  "on a Spade older than keys, a lost start is unknown, never claimed, when %s",
  async (_why, message, made) => {
    const { link } = spade([], makesThenLoses(...made));
    expect(await spadeStart(link, { text: message.text }, message, key)).toEqual({
      kind: "unknown",
    });
  },
);

test("on a Spade older than keys, a new conversation with the same words but images is someone else's", async () => {
  const { link } = spade([], makesThenLoses({ id: "a", updated_at: 2, first: "Hi", images: 2 }));
  await expect(spadeStart(link, { text: "Hi" }, words("Hi"), key)).rejects.toThrow(
    SpadeRequestError,
  );
});

test("on a Spade older than keys, a start lost before it made anything comes back to be sent again", async () => {
  const { link } = spade([earlier], async () => {
    throw lost;
  });
  await expect(spadeStart(link, { text: "Hi" }, words("Hi"), key)).rejects.toThrow(
    SpadeRequestError,
  );
});

test("a start whose answer was lost, with Spade out of reach to ask, is unknown", async () => {
  const { link, asked } = spade(
    [],
    async () => {
      throw new ClientError("timeout", "timeout");
    },
    false,
  );
  expect(await spadeStart(link, { text: "Hi" }, words("Hi"), key)).toEqual({ kind: "unknown" });
  expect(asked.filter((call) => call.startsWith("GET"))).toEqual(["GET /v1/conversations"]);
});

test("a start Spade refused comes back at once, without looking for it", async () => {
  const { link, asked } = spade([], async () => {
    throw new SpadeRequestError("Today's spending cap is reached.", 402);
  });
  await expect(spadeStart(link, { text: "Hi" }, words("Hi"), key)).rejects.toThrow("spending cap");
  expect(asked).toEqual(["GET /v1/conversations", "POST /v1/conversations"]);
});

test("a start carries its own client key", async () => {
  const { link, posted } = spade([], async () => '{"id":"c1"}');
  await spadeStart(link, { text: "Hi" }, words("Hi"), key);
  expect(posted).toEqual([{ text: "Hi", client_key: key }]);
});

test("a lost start is found by its key, past a newer conversation with the same words", async () => {
  const { link } = spade(
    [],
    makesThenLoses(
      { id: "mine", updated_at: 2, first: "Hi", client_key: key },
      { id: "theirs", updated_at: 3, first: "Hi", client_key: "another-start" },
    ),
  );
  expect(await spadeStart(link, { text: "Hi" }, words("Hi"), key)).toEqual({
    kind: "started",
    id: "mine",
  });
});

test("an identical start that overlaps isn't claimed: this one goes again by its key and gets its own", async () => {
  let starts = 0;
  const { link, posted } = spade([], async (stored, body) => {
    starts += 1;
    if (starts === 1) {
      // The other start's conversation shows first; this one's isn't made yet.
      stored.push({ id: "theirs", updated_at: 2, first: "Hi", client_key: "another-start" });
      throw lost;
    }
    stored.push({ id: "mine", updated_at: 3, first: "Hi", client_key: String(body.client_key) });
    return '{"id":"mine"}';
  });
  expect(await spadeStart(link, { text: "Hi" }, words("Hi"), key)).toEqual({
    kind: "started",
    id: "mine",
  });
  expect(posted.map((body) => body.client_key)).toEqual([key, key]);
});

test("a lost start whose start sent again is lost too is unknown", async () => {
  const { link } = spade(
    [{ id: "old", updated_at: 1, first: "Earlier", client_key: null }],
    async () => {
      throw lost;
    },
  );
  expect(await spadeStart(link, { text: "Hi" }, words("Hi"), key)).toEqual({ kind: "unknown" });
});

test("a start with images is settled by its key, where the words alone couldn't tell", async () => {
  const { link } = spade(
    [],
    makesThenLoses({ id: "mine", updated_at: 2, first: "Look", images: 1, client_key: key }),
  );
  expect(await spadeStart(link, { text: "Look" }, words("Look", 1), key)).toEqual({
    kind: "started",
    id: "mine",
  });
});

test("the composer clears a start's words only once it started, and keeps an unknown one with a note", () => {
  expect(spadeStartWords("started")).toEqual({ keep: false, note: undefined });
  expect(spadeStartWords("refused")).toEqual({ keep: true, note: undefined });
  expect(spadeStartWords("unknown")).toEqual({ keep: true, note: spadeUnconfirmedNote });
});
