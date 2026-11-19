import { expect, it } from "vitest";
import type { FilesService } from "@ace/files";
import { FilesRequestError, type FileMatches, type FilesSearchOptions } from "@ace/files-native";
import { FileOperation, ThreadId, type FilesServerMessage } from "@ace/protocol";
import { contentSearches, type ContentSearcher, type SearchRequest } from "./content-search.ts";
import type { ListingScope } from "./list-folder.ts";
import { utf16Ranges } from "./search-hits.ts";
import { TestClock } from "./test-clock.ts";

const threadId = ThreadId.parse("main");

function request(requestId: string, pattern = "needle"): SearchRequest {
  const operation = FileOperation.parse({ op: "search", pattern });
  if (operation.op !== "search") throw new Error("expected a search");
  return { requestId, threadId, operation };
}

/** A stand-in ace-files whose searches the test drives: report files, then finish. */
function searcher() {
  const running: {
    path: string;
    options: FilesSearchOptions;
    finish(matches?: number): void;
  }[] = [];
  const tool: ContentSearcher = {
    search: (path, _query, options) =>
      new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () =>
          reject(new FilesRequestError("CANCELLED", "the search was cancelled")),
        );
        running.push({
          path,
          options,
          finish: (matches = 0) => resolve({ files: 1, bytes: 0, matches, limitHit: false }),
        });
      }),
  };
  return { running, tool };
}

function file(path: string, count: number): FileMatches {
  return {
    path,
    lines: Array.from({ length: count }, (_, index) => ({
      line: index + 1,
      column: 0,
      preview: "a needle",
      ranges: [[2, 8]],
    })),
  };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

function harness(options: { allowed?: () => boolean; buffered?: () => number } = {}) {
  const clock = new TestClock();
  const sent: FilesServerMessage[] = [];
  const fake = searcher();
  const resolve: ListingScope = () =>
    Promise.resolve({
      service: undefined as unknown as FilesService,
      root: "/checkout",
      allowed: options.allowed ?? (() => true),
    });
  const tasks: Promise<void>[] = [];
  const searches = contentSearches({
    resolve,
    tool: fake.tool,
    clock,
    push: (message) => sent.push(message),
    buffered: options.buffered ?? (() => 0),
    replyAllowed: () => options.allowed?.() ?? true,
    run: (task) => tasks.push(task),
  });
  const lines = (searchId: string) =>
    sent
      .filter((message) => message.type === "files.search.matches" && message.searchId === searchId)
      .flatMap((message) => (message.type === "files.search.matches" ? message.files : []))
      .flatMap((entry) => entry.lines).length;
  const end = (requestId: string) =>
    sent.find(
      (message) =>
        (message.type === "files.result" || message.type === "files.error") &&
        message.requestId === requestId,
    );
  return { clock, sent, fake, searches, tasks, settle, lines, end };
}

it("sends a full batch at once, the rest after the window, then the summary", async () => {
  const h = harness();
  h.searches.start(request("s1"));
  await h.settle();
  const search = h.fake.running[0];
  if (!search) throw new Error("no search started");
  expect(search.path).toBe("/checkout");
  search.options.onMatches(file("a.ts", 150));
  search.options.onMatches(file("b.ts", 100));
  const batches = () => h.sent.filter((message) => message.type === "files.search.matches");
  expect(batches()).toHaveLength(1);
  expect(h.lines("s1")).toBe(200);
  h.clock.advance(50);
  expect(batches()).toHaveLength(2);
  expect(h.lines("s1")).toBe(250);
  search.finish(250);
  await Promise.all(h.tasks);
  expect(h.end("s1")).toEqual({
    type: "files.result",
    requestId: "s1",
    value: { files: 1, matches: 250, truncated: false },
  });
});

it("holds batches while the connection is backed up and ends only after they go", async () => {
  let buffered = 1024 * 1024;
  const h = harness({ buffered: () => buffered });
  h.searches.start(request("slow"));
  await h.settle();
  const search = h.fake.running[0];
  if (!search) throw new Error("no search started");
  search.options.onMatches(file("a.ts", 300));
  search.finish(300);
  await h.settle();
  h.clock.advance(200);
  expect(h.lines("slow")).toBe(0);
  expect(h.end("slow")).toBeUndefined();
  buffered = 0;
  h.clock.advance(50);
  await Promise.all(h.tasks);
  expect(h.lines("slow")).toBe(300);
  expect(h.end("slow")).toMatchObject({ type: "files.result" });
});

it("a newer search of the same thread cancels the one before it", async () => {
  const h = harness();
  h.searches.start(request("old", "first"));
  await h.settle();
  h.searches.start(request("new", "second"));
  await h.settle();
  const [old, current] = h.fake.running;
  old?.options.onMatches(file("late.ts", 1));
  current?.options.onMatches(file("fresh.ts", 1));
  current?.finish(1);
  h.clock.advance(50);
  await Promise.all(h.tasks);
  expect(h.end("old")).toMatchObject({ type: "files.error", code: "CANCELLED" });
  expect(h.lines("old")).toBe(0);
  expect(h.lines("new")).toBe(1);
});

it("an abort or a closed connection stops the search", async () => {
  const h = harness();
  h.searches.start(request("aborted"));
  await h.settle();
  expect(h.searches.abort("aborted")).toBe(true);
  expect(h.searches.abort("unknown")).toBe(false);
  await Promise.all(h.tasks);
  expect(h.end("aborted")).toMatchObject({ code: "CANCELLED" });

  h.searches.start(request("closing"));
  await h.settle();
  h.searches.close();
  await Promise.all(h.tasks);
  expect(h.fake.running[1]?.options.signal?.aborted).toBe(true);
  expect(h.end("closing")).toBeUndefined();
});

it("a read grant lost mid-search sends nothing more and ends forbidden", async () => {
  let allowed = true;
  const h = harness({ allowed: () => allowed });
  h.searches.start(request("revoked"));
  await h.settle();
  const search = h.fake.running[0];
  allowed = false;
  search?.options.onMatches(file("secret.ts", 3));
  h.clock.advance(50);
  await Promise.all(h.tasks);
  expect(h.lines("revoked")).toBe(0);
  expect(h.end("revoked")).toMatchObject({ type: "files.error", code: "FORBIDDEN" });
});

it("a machine without ace-files answers with the retryable code", async () => {
  const sent: FilesServerMessage[] = [];
  const tasks: Promise<void>[] = [];
  const searches = contentSearches({
    resolve: () =>
      Promise.resolve({
        service: undefined as unknown as FilesService,
        root: "/checkout",
        allowed: () => true,
      }),
    tool: undefined,
    clock: new TestClock(),
    push: (message) => sent.push(message),
    buffered: () => 0,
    replyAllowed: () => true,
    run: (task) => tasks.push(task),
  });
  searches.start(request("missing"));
  await Promise.all(tasks);
  expect(sent).toMatchObject([{ type: "files.error", code: "FILES_RESTARTING" }]);
});

it("highlights land on the same characters in UTF-16 as the UTF-8 bytes named", () => {
  // "é" is 2 bytes, "😀" 4 bytes and 2 UTF-16 units.
  const preview = "é😀 needle";
  const start = Buffer.byteLength("é😀 ");
  const [range] = utf16Ranges(preview, [[start, start + 6]]);
  expect(range && preview.slice(range[0], range[1])).toBe("needle");
  expect(utf16Ranges("abc", [[0, 99]])).toEqual([[0, 3]]);
});
