import { expect, it } from "vitest";
import type { FilesService } from "@ace/files";
import { ClientMessage, ThreadId, type FilesServerMessage, type FolderPage } from "@ace/protocol";
import type { FolderWatch } from "./folder-watch.ts";
import { relayFiles, type RelayFilesOptions } from "./relay-files.ts";
import type { ListingScope } from "./list-folder.ts";

const threadId = ThreadId.parse("phone");

const page: FolderPage = {
  entries: [
    { name: "main.ts", path: "src/main.ts", kind: "file", size: 1, mtimeMs: 0, ignored: false },
  ],
  nextCursor: null,
  total: 1,
};

function listing(requestId = "list"): ClientMessage {
  return ClientMessage.parse({
    type: "files.request",
    requestId,
    threadId,
    operation: { op: "list.folder", path: "src" },
  });
}

const allowed: ListingScope = async () => ({
  service: undefined as unknown as FilesService,
  root: "/checkout",
  release: () => {},
  allowed: () => true,
});

function setup(overrides: Partial<RelayFilesOptions> = {}) {
  const pushed: FilesServerMessage[] = [];
  const watched: { root: string; folders: readonly string[] }[] = [];
  const folders = {
    watch: async (_client: unknown, _thread: ThreadId, root: string, list: readonly string[]) => {
      watched.push({ root, folders: list });
    },
    disconnect: async () => {},
  } as unknown as FolderWatch;
  const files = relayFiles({
    clientId: "phone",
    authorize: () => true,
    threadAccess: () => true,
    matches: () => true,
    resolve: allowed,
    tool: {
      listFolder: () => Promise.resolve(page),
    } as unknown as RelayFilesOptions["tool"],
    folders,
    push: (message) => pushed.push(message),
    ...overrides,
  });
  return { files, pushed, watched };
}

it("answers a listing on a task instead of holding the channel", async () => {
  let answer!: (value: FolderPage) => void;
  const { files, pushed } = setup({
    tool: {
      listFolder: () => new Promise<FolderPage>((resolve) => (answer = resolve)),
    } as unknown as RelayFilesOptions["tool"],
  });
  expect(files.accept(listing())).toBe(true);
  expect(pushed).toEqual([]);
  await settle();
  answer(page);
  await settle();
  expect(pushed).toMatchObject([
    { type: "files.result", requestId: "list", value: { entries: [{ path: "src/main.ts" }] } },
  ]);
});

it("keeps at most four listings running on one channel", async () => {
  const started: string[] = [];
  const { files, pushed } = setup({
    tool: {
      listFolder: (_path: string, _dir: string, _options: { signal?: AbortSignal }) => {
        started.push("list");
        return new Promise<FolderPage>(() => {});
      },
    } as unknown as RelayFilesOptions["tool"],
  });
  for (const requestId of ["a", "b", "c", "d"]) {
    expect(files.accept(listing(requestId))).toBe(true);
  }
  files.accept(listing("e"));
  await settle();
  expect(started).toHaveLength(4);
  expect(pushed).toMatchObject([{ type: "files.error", requestId: "e", code: "BUSY" }]);
});

it("starts a watch on a task through the scope's binding", async () => {
  const { files, watched } = setup();
  const message = ClientMessage.parse({ type: "files.watch", threadId, folders: ["src"] });
  expect(files.accept(message)).toBe(true);
  await settle();
  expect(watched).toEqual([{ root: "/checkout", folders: ["src"] }]);
});

it("a closed channel pushes nothing more", async () => {
  let answer!: (value: FolderPage) => void;
  const { files, pushed } = setup({
    tool: {
      listFolder: () => new Promise<FolderPage>((resolve) => (answer = resolve)),
    } as unknown as RelayFilesOptions["tool"],
  });
  files.accept(listing());
  await settle();
  files.close();
  answer(page);
  await settle();
  expect(pushed).toEqual([]);
});

it("a refused binding answers its listing without asking ace-files", async () => {
  const { files, pushed } = setup({
    resolve: async () => ({
      service: undefined as unknown as FilesService,
      root: "/checkout",
      allowed: () => false,
      release: () => {},
    }),
  });
  files.accept(listing());
  await settle();
  expect(pushed).toMatchObject([{ type: "files.error", requestId: "list", code: "FORBIDDEN" }]);
});

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}
