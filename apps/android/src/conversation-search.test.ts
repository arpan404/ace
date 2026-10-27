import { expect, it, vi } from "vitest";
import type { ItemsWindowInput, RequestOptions, ServiceRequest } from "@ace/client";
import {
  ConversationSearch,
  hitExcerpt,
  hitId,
  readHistoryWindow,
  searchProblemForCode,
  type ConversationHit,
  type SearchServiceClient,
} from "./conversation-search.ts";

type Recorded = {
  text: string;
  cursor?: string;
  resolve: (cursor: string | null) => void;
  reject: (error: Error) => void;
};

function searchHit(title: string) {
  return {
    threadId: "thread",
    threadTitle: title,
    itemId: "message",
    workspaceId: "workspace",
    provider: "codex",
    status: "done",
    statusSeq: 0,
    kind: "message",
    createdAt: 0,
    title: { text: title, highlights: [] as never[] },
    snippet: { text: title, highlights: [] as never[] },
    score: 1,
  } as const;
}

function fakeClient(
  onRequest: (record: Recorded) => void,
): SearchServiceClient & { requests: Recorded[] } {
  const requests: Recorded[] = [];
  const client = {
    state: "ready" as const,
    requests,
    async request(input: ServiceRequest) {
      if (input.type !== "search.query") throw new Error("unexpected request");
      const { text, cursor } = input;
      const pending = Promise.withResolvers<{
        type: "search.results";
        hits: unknown[];
        cursor: unknown;
      }>();
      const record: Recorded = {
        text,
        ...(cursor ? { cursor } : {}),
        resolve: (next) =>
          pending.resolve({
            type: "search.results",
            hits: [searchHit(`${text} result`)],
            cursor: next,
          }),
        reject: (error) => pending.reject(error),
      };
      requests.push(record);
      onRequest(record);
      const reply = await pending.promise;
      return reply as never;
    },
  };
  return client;
}

const noDelay = { sleep: async () => {} };

async function waitFor(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("No search request arrived");
}

it("a late search cannot replace the newer query or append its pages", async () => {
  const seen: Recorded[] = [];
  const client = fakeClient((record) => seen.push(record));
  const search = new ConversationSearch(noDelay);
  const old = search.search(client, "old", "", undefined);
  await waitFor(() => seen.length === 1);
  const newer = search.search(client, "new", "", undefined);
  await waitFor(() => seen.length === 2);
  seen[1]!.resolve("new-page");
  await newer;
  expect(search.selection.getSnapshot().hits.map((entry) => entry.threadTitle)).toEqual([
    "new result",
  ]);
  seen[0]!.resolve("old-page");
  await old;
  expect(search.selection.getSnapshot().hits.map((entry) => entry.threadTitle)).toEqual([
    "new result",
  ]);
  expect(search.selection.getSnapshot().cursor).toBe("new-page");
  const more = search.more(client, "new", "", undefined);
  await waitFor(() => seen.length === 3);
  await search.search(client, "", "", undefined);
  seen[2]!.resolve(null);
  await more;
  const snapshot = search.selection.getSnapshot();
  expect(snapshot.hits).toEqual([]);
  expect(snapshot.cursor).toBeNull();
  expect(snapshot.loading).toBe(false);
});

it("a refused cursor offers a refresh without erasing results", async () => {
  const seen: Recorded[] = [];
  const client = fakeClient((record) => seen.push(record));
  const search = new ConversationSearch(noDelay);
  const first = search.search(client, "find", "message", "thread");
  await waitFor(() => seen.length === 1);
  expect(seen[0]).toMatchObject({ text: "find" });
  seen[0]!.resolve("page");
  await first;
  const stale: SearchServiceClient = {
    state: "ready",
    request: async () => ({ type: "search.error", code: "search_cursor_stale" }) as never,
  };
  await search.more(stale, "find", "message", "thread");
  const snapshot = search.selection.getSnapshot();
  expect(snapshot.hits.map((entry) => entry.threadTitle)).toEqual(["find result"]);
  expect(snapshot.problem).toMatch(/index changed/);
  expect(snapshot.loading).toBe(false);
});

it("maps daemon error codes to the iOS wording", () => {
  expect(searchProblemForCode("search_cursor_stale")).toMatch(/index changed/);
  expect(searchProblemForCode("search_invalid_query")).toMatch(/simpler words/);
  expect(searchProblemForCode("search_failed")).toMatch(/connection/);
  expect(searchProblemForCode(undefined)).toMatch(/connection/);
});

it("identifies hits the way iOS does", () => {
  const message = {
    threadId: "thread",
    itemId: "item",
    kind: "message",
    title: { text: "Title", highlights: [] },
    snippet: { text: "Body", highlights: [] },
  } as unknown as ConversationHit;
  expect(hitId(message)).toBe("thread:item:message");
  expect(hitExcerpt(message)).toBe("Body");
  const titleHit = { ...message, itemId: undefined, kind: "thread" } as unknown as ConversationHit;
  expect(hitId(titleHit)).toBe("thread:title:thread");
  expect(hitExcerpt(titleHit)).toBe("Title");
});

it("an empty query clears results and an offline machine explains itself", async () => {
  const client = fakeClient((record) => record.resolve(null));
  const search = new ConversationSearch(noDelay);
  await search.search(client, "hello", "", undefined);
  expect(search.selection.getSnapshot().hits.map((entry) => entry.threadTitle)).toEqual([
    "hello result",
  ]);
  await search.search(client, "   ", "", undefined);
  expect(search.selection.getSnapshot().hits).toEqual([]);
  const offline: SearchServiceClient = {
    state: "reconnecting",
    request: async () => {
      throw new Error("must not send while offline");
    },
  };
  await search.search(offline, "hello", "", undefined);
  expect(search.selection.getSnapshot().problem).toMatch(/offline/i);
});

it("an outer abort cancels the debounced search and releases its listener", async () => {
  let requested = 0;
  const client = fakeClient(() => {
    requested++;
  });
  const hanging = {
    sleep: (_ms: number, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }),
  };
  const search = new ConversationSearch(hanging);
  const outer = new AbortController();
  const addSpy = vi.spyOn(outer.signal, "addEventListener");
  const removeSpy = vi.spyOn(outer.signal, "removeEventListener");
  const pending = search.search(client, "hello", "", undefined, { signal: outer.signal });
  outer.abort();
  await pending;
  expect(requested).toBe(0);
  const snapshot = search.selection.getSnapshot();
  expect(snapshot.loading).toBe(false);
  expect(snapshot.hits).toEqual([]);
  expect(addSpy).toHaveBeenCalledTimes(1);
  expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("a settled search releases the outer signal listener", async () => {
  const client = fakeClient((record) => record.resolve(null));
  const search = new ConversationSearch(noDelay);
  const outer = new AbortController();
  const removeSpy = vi.spyOn(outer.signal, "removeEventListener");
  await search.search(client, "hello", "", undefined, { signal: outer.signal });
  expect(search.selection.getSnapshot().hits.map((entry) => entry.threadTitle)).toEqual([
    "hello result",
  ]);
  expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("a history read forwards its signal so dismissal can cancel it", async () => {
  let seenSignal: AbortSignal | undefined;
  const client = {
    async itemsWindow(_input: ItemsWindowInput, options: RequestOptions = {}) {
      seenSignal = options.signal;
      const pending = Promise.withResolvers<never>();
      options.signal?.addEventListener(
        "abort",
        () => pending.reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
      return pending.promise;
    },
  };
  const ctrl = new AbortController();
  const pending = readHistoryWindow(client, "thread", "message", { signal: ctrl.signal });
  expect(seenSignal).toBe(ctrl.signal);
  ctrl.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

it("a history read resolves the window around the match", async () => {
  const items = [{ id: "message" }];
  const seen: ItemsWindowInput[] = [];
  const client = {
    async itemsWindow(input: ItemsWindowInput) {
      seen.push(input);
      return { items } as never;
    },
  };
  await expect(readHistoryWindow(client, "thread", "message")).resolves.toBe(items);
  expect(seen).toMatchObject([{ threadId: "thread", before: 25, after: 25 }]);
});
