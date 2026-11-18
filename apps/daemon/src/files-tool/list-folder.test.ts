import { expect, it } from "vitest";
import { FilesService } from "@ace/files";
import { FileOperation, ThreadId, WorkspaceId, type FolderPage } from "@ace/protocol";
import { listFolderPage, type FolderLister, type ListingScope } from "./list-folder.ts";

const threadId = ThreadId.parse("main");
const workspaceId = WorkspaceId.parse("project");
const listing = FileOperation.parse({ op: "list.folder", path: "src", limit: 20, cursor: "c1" });
if (listing.op !== "list.folder") throw new Error("expected a folder listing");

const page: FolderPage = { entries: [], nextCursor: null, total: 0 };

function tool() {
  const calls: Parameters<FolderLister["listFolder"]>[] = [];
  const lister: FolderLister = {
    listFolder: (...args) => {
      calls.push(args);
      return Promise.resolve(page);
    },
  };
  return { calls, lister };
}

function scope(options: { allowed?: boolean | (() => boolean); root?: string | undefined } = {}) {
  const released: string[] = [];
  const calls: unknown[][] = [];
  const resolve: ListingScope = (thread, support, operation, workspace) => {
    calls.push([thread, support, operation?.op, workspace]);
    if (support !== undefined) return Promise.reject(new Error("Support export unavailable"));
    return Promise.resolve({
      service: undefined as unknown as FilesService,
      root: "root" in options ? options.root : "/w",
      release: () => released.push("release"),
      allowed: () =>
        typeof options.allowed === "function" ? options.allowed() : (options.allowed ?? true),
    });
  };
  return { calls, released, resolve };
}

it("answers a thread's folder from ace-files with the request's paging", async () => {
  const lister = tool();
  const bindings = scope();
  const result = await listFolderPage(bindings.resolve, lister.lister, {
    threadId,
    scope: undefined,
    workspaceId: undefined,
    operation: listing,
  });
  expect(result).toBe(page);
  expect(bindings.calls).toEqual([[threadId, undefined, "list.folder", undefined]]);
  expect(lister.calls).toEqual([["/w", "src", { limit: 20, cursor: "c1" }]]);
  expect(bindings.released).toEqual(["release"]);
});

it("lists a project's folder before any thread exists", async () => {
  const lister = tool();
  const bindings = scope();
  await listFolderPage(bindings.resolve, lister.lister, {
    threadId: undefined,
    scope: undefined,
    workspaceId,
    operation: listing,
  });
  expect(bindings.calls).toEqual([[undefined, undefined, "list.folder", workspaceId]]);
  expect(lister.calls[0]?.[0]).toBe("/w");
});

it("refuses a thread the binding does not let it read", async () => {
  const lister = tool();
  const bindings = scope({ allowed: false });
  await expect(
    listFolderPage(bindings.resolve, lister.lister, {
      threadId,
      scope: undefined,
      workspaceId: undefined,
      operation: listing,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(lister.calls).toEqual([]);
  expect(bindings.released).toEqual(["release"]);
});

it("refuses a listing whose read access is revoked while ace-files lists", async () => {
  const answer = Promise.withResolvers<FolderPage>();
  let allowed = true;
  const bindings = scope({ allowed: () => allowed });
  const listingInFlight = listFolderPage(
    bindings.resolve,
    { listFolder: () => answer.promise },
    {
      threadId,
      scope: undefined,
      workspaceId: undefined,
      operation: listing,
    },
  );
  await Promise.resolve();
  allowed = false;
  answer.resolve({
    entries: [
      { name: "main.ts", path: "src/main.ts", kind: "file", size: 1, mtimeMs: 0, ignored: false },
    ],
    nextCursor: null,
    total: 1,
  });
  await expect(listingInFlight).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: "File access denied",
  });
  expect(bindings.released).toEqual(["release"]);
});

it("refuses a request with neither a thread nor a project", async () => {
  const lister = tool();
  const bindings = scope();
  await expect(
    listFolderPage(bindings.resolve, lister.lister, {
      threadId: undefined,
      scope: undefined,
      workspaceId: undefined,
      operation: listing,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(bindings.calls).toEqual([]);
});

it("refuses support exports, which have no folders", async () => {
  const lister = tool();
  const bindings = scope();
  await expect(
    listFolderPage(bindings.resolve, lister.lister, {
      threadId: undefined,
      scope: "support",
      workspaceId: undefined,
      operation: listing,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(lister.calls).toEqual([]);
});

it("fails retryably when this machine has no ace-files", async () => {
  const bindings = scope();
  await expect(
    listFolderPage(bindings.resolve, undefined, {
      threadId,
      scope: undefined,
      workspaceId: undefined,
      operation: listing,
    }),
  ).rejects.toMatchObject({ code: "FILES_RESTARTING", retryable: true });
  expect(bindings.released).toEqual(["release"]);
});

it("refuses a binding with no checkout to list", async () => {
  const lister = tool();
  const bindings = scope({ root: undefined });
  await expect(
    listFolderPage(bindings.resolve, lister.lister, {
      threadId,
      scope: undefined,
      workspaceId: undefined,
      operation: listing,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(lister.calls).toEqual([]);
});
