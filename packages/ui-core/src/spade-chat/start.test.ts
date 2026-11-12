import { ClientError } from "@ace/client";
import { expect, test } from "vitest";
import { SpadeRequestError, spadeStart, type SpadeStartLink } from "./index.ts";

/*
 * Starting a conversation when its answer may be lost: Spade has no key to say "this start",
 * so a lost answer is settled by what Spade lists afterwards.
 */

interface Stored {
  id: string;
  updated_at: number;
  first: string;
}

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
      return JSON.stringify(
        found ? [{ seq: 1, at: 0, event: { type: "user_message", text: found.first } }] : [],
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
const earlier = { id: "old", updated_at: 1, first: "What's on today?" };

test("a start that answers opens its conversation", async () => {
  const { link } = spade([], async () => '{"id":"c1"}');
  expect(await spadeStart(link, { text: "Hi" }, "Hi")).toEqual({ kind: "started", id: "c1" });
});

test("a start whose answer was lost opens the conversation Spade made from it, not an older one", async () => {
  const { link } = spade([earlier], async (stored) => {
    stored.push({ id: "new", updated_at: 2, first: "What's on today?" });
    throw lost;
  });
  expect(await spadeStart(link, { text: "What's on today?" }, "What's on today?")).toEqual({
    kind: "started",
    id: "new",
  });
});

test("a start whose answer was lost before Spade made anything comes back to be sent again", async () => {
  const { link } = spade([earlier], async () => {
    throw lost;
  });
  await expect(spadeStart(link, { text: "Hi" }, "Hi")).rejects.toThrow(SpadeRequestError);
});

test("a start whose answer was lost, with Spade out of reach to ask, is unknown", async () => {
  const { link, asked } = spade(
    [],
    async () => {
      throw new ClientError("timeout", "timeout");
    },
    false,
  );
  expect(await spadeStart(link, { text: "Hi" }, "Hi")).toEqual({ kind: "unknown" });
  expect(asked.filter((call) => call.startsWith("GET"))).toEqual(["GET /v1/conversations"]);
});

test("a start Spade refused comes back at once, without looking for it", async () => {
  const { link, asked } = spade([], async () => {
    throw new SpadeRequestError("Today's spending cap is reached.", 402);
  });
  await expect(spadeStart(link, { text: "Hi" }, "Hi")).rejects.toThrow("spending cap");
  expect(asked).toEqual(["GET /v1/conversations", "POST /v1/conversations"]);
});
