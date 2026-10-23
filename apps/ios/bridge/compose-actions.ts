import type { ClientCore } from "@ace/client";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import { ComposeSearch } from "./compose-search.ts";
import { ChoiceAction, CreateAction, NewThread, type NewThreadMemory } from "./new-thread.ts";
import { AttachmentTray, Picked, nativeChunks, type ChunkReader } from "./thread-attachments.ts";

/*
 * The `compose` (New thread, Add project) actions Swift sends, parsed once and routed to their
 * sessions. `false` means the action couldn't be read. New thread's first-message files live
 * here, in the chosen project's draft scope.
 */

const id = z.string().min(1).max(128);
const ComposeAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open") }),
  z.object({ kind: z.literal("close") }),
  z.object({ kind: z.literal("projects") }),
  z.object({ kind: z.literal("agents") }),
  z.object({ kind: z.literal("branches"), workspaceId: id }),
  z.object({ kind: z.literal("mentions"), workspaceId: id, query: z.string().max(128) }),
  z.object({ kind: z.literal("folders"), query: z.string().max(256) }),
  z.object({
    kind: z.literal("addProject"),
    path: z.string().min(1).max(4096),
    requestId: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal("createProject"),
    payload: z.unknown(),
    requestId: z.string().min(1).max(64),
  }),
  CreateAction,
  ChoiceAction,
  /** A file picked for the first message, uploaded into the project's draft scope. */
  z.object({ kind: z.literal("attach"), workspaceId: id, file: Picked }),
  z.object({ kind: z.literal("detach"), localId: z.string().min(1).max(64) }),
]);
export class ComposeActions {
  readonly newThread: NewThread;
  readonly search: ComposeSearch;
  readonly #owner: ClientCore;
  readonly #sink: PatchSink;
  readonly #chunks: ChunkReader;
  /** The first message's files, in one project's draft scope. */
  #tray: { workspaceId: string; tray: AttachmentTray; stop: AbortController } | undefined;
  constructor(
    owner: ClientCore,
    sink: PatchSink,
    preview: Preview,
    now: () => number,
    chunks: ChunkReader = nativeChunks,
    memory?: NewThreadMemory,
  ) {
    this.#owner = owner;
    this.#sink = sink;
    this.#chunks = chunks;
    this.search = new ComposeSearch(owner, sink, preview);
    this.newThread = new NewThread(
      owner,
      sink,
      preview,
      now,
      {
        tray: (workspaceId) =>
          this.#tray?.workspaceId === workspaceId ? this.#tray.tray : undefined,
        adopt: (draftId) => this.search.adopt(draftId),
      },
      memory,
    );
  }
  compose(raw: unknown): boolean {
    const parsed = ComposeAction.safeParse(raw);
    if (!parsed.success) return false;
    const action = parsed.data;
    switch (action.kind) {
      case "open":
        this.newThread.open();
        break;
      case "close":
        this.#dropTray();
        this.search.release();
        break;
      case "choice":
        this.newThread.choose(action);
        break;
      case "attach":
        this.#trayFor(action.workspaceId).attach(action.file, this.newThread.reader());
        break;
      case "detach":
        this.#tray?.tray.detach(action.localId);
        break;
      case "projects":
        void this.newThread.projects();
        break;
      case "agents":
        void this.newThread.agents();
        break;
      case "branches":
        void this.newThread.branches(action.workspaceId);
        break;
      case "mentions":
        void this.search.mentions(action.workspaceId, action.query);
        break;
      case "folders":
        void this.search.folders(action.query);
        break;
      case "addProject":
        void this.search.addProject(action.path, action.requestId);
        break;
      case "createProject":
        void this.search.createProject(action.payload, action.requestId);
        break;
      case "create":
        void this.newThread.create(action);
        break;
    }
    return true;
  }
  /** The project's tray; files picked for another project went with that project's scope. */
  #trayFor(workspaceId: string): AttachmentTray {
    if (this.#tray?.workspaceId === workspaceId) return this.#tray.tray;
    this.#dropTray();
    const stop = new AbortController();
    const tray = new AttachmentTray(
      this.#owner,
      { draftId: () => this.search.draftScope(workspaceId) },
      stop.signal,
      (files) =>
        this.#sink.put("compose:attachments", () => ({
          type: "compose.attachments",
          workspaceId,
          files,
          blocked: this.#blocked(),
        })),
      this.#chunks,
    );
    this.#tray = { workspaceId, tray, stop };
    return tray;
  }
  /** Why the first message can't go yet because of its files; null when they're ready. */
  #blocked(): string | null {
    const files = this.#tray?.tray.context();
    return files && "refused" in files ? files.refused : null;
  }
  #dropTray(): void {
    const held = this.#tray;
    if (!held) return;
    this.#tray = undefined;
    held.stop.abort();
    held.tray.discard();
  }
}
