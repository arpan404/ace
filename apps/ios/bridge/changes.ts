import type { ChangeTap, ClientCore, ThreadSource } from "@ace/client";
import {
  ThreadId,
  type SourceControlSelection,
  type ThreadDetails,
  type WorkspaceActionRequest,
} from "@ace/protocol";
import type { DiffScope } from "@ace/ui-core";
import type { DiffRows } from "@ace/ui-core/review";
import { patchFiles } from "@ace/ui-core/mobile";
import type { PatchSink, Preview } from "./agents.ts";
import { sectionDiff, TurnDiffs } from "./changes-diffs.ts";
import { OpenFiles, openFilesLimits, type OpenFilesLimits } from "./changes-files.ts";
import { ChangesKept, type DiffLayout } from "./changes-kept.ts";
import { SheetReview } from "./changes-review.ts";
import { ChangesScope, type Reads } from "./changes-scope.ts";
import { summaryPatch, treePatch } from "./changes-summary.ts";

export type { Reads } from "./changes-scope.ts";

/** What the Changes sheet needs of the SDK: correlated reads and online commands. */
export type ChangesOwner = Pick<ClientCore, "request" | "command">;
export type ChangesStore = Pick<
  ThreadSource,
  "thread" | "observe" | "order" | "item" | "run" | "agent"
>;

/** A refusal code from the daemon's workspace service, kept for the shared copy table. */
export class WorkspaceRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface ChangesOptions {
  /** The phone's kept review state, shared by every session. */
  kept?: ChangesKept;
  now?: () => number;
  limits?: OpenFilesLimits;
}

/** Whatever of the details a refresh depends on: a commit, a move or a new PR link. */
const detailsKey = (details: ThreadDetails | undefined) =>
  JSON.stringify([
    details?.head,
    details?.worktree,
    details?.branch,
    details?.diff,
    details?.ahead,
    details?.linkedPrs?.[0]?.number,
    details?.linkedPrs?.[0]?.state,
  ]);

/** Change keys that can move which files a turn edited. */
function touchesTurns(store: ChangesStore, keys: ReadonlySet<string>): boolean {
  for (const key of keys) {
    if (key === "order" || key === "agents" || key === "history" || key.startsWith("run:"))
      return true;
    if (!key.startsWith("item:")) continue;
    const item = store.item(key.slice(5));
    if (item?.type === "tool_call" && "changes" in item.call.detail) return true;
  }
  return false;
}

/** Draft times without a clock (tests): increasing, so drafts stay apart and in order. */
function counter(): () => number {
  let at = 0;
  return () => ++at;
}

const memoryKept = () => new ChangesKept({ load: async () => undefined, save: async () => {} });

/**
 * The Changes sheet while it is open. The bridge holds the daemon's bounded reads (at most 500
 * status rows and a 256 KiB patch) and the thread's turns, and ships the scope's file list, a
 * tree of it, the next step, the review, and the open files' diffs page by page. Closing
 * releases all of it.
 */
export class ChangesSession {
  readonly threadId: string;
  readonly epoch: number;
  #owner: ChangesOwner;
  #store: ChangesStore;
  #sink: PatchSink;
  #preview: Preview;
  #kept: ChangesKept;
  #scope: ChangesScope;
  #diffs = new TurnDiffs();
  #files: OpenFiles;
  readonly review: SheetReview;
  #reads: Reads | undefined;
  #state: "loading" | "ready" | "error" = "loading";
  #error = "";
  #reading: Promise<void> | undefined;
  #again = false;
  #closed = false;
  #details: string;
  #stops: (() => void)[] = [];
  /** A git action is running; the step is not offered twice. */
  busy = false;
  /**
   * The AI draft the person last took for a commit or PR (`git-drafts.ts`): the changes it was
   * written against, so the daemon refuses to publish it once they moved.
   */
  draft:
    | { for: "commit" | "create-pr"; fingerprint: string; selection: SourceControlSelection }
    | undefined;
  /** The draft being written, cancellable by its request id. */
  drafting: { id: string; controller: AbortController } | undefined;

  constructor(
    owner: ChangesOwner,
    store: ChangesStore,
    threadId: string,
    epoch: number,
    sink: PatchSink,
    preview: Preview,
    options: ChangesOptions = {},
  ) {
    this.#owner = owner;
    this.#store = store;
    this.threadId = threadId;
    this.epoch = epoch;
    this.#sink = sink;
    this.#preview = preview;
    this.#kept = options.kept ?? memoryKept();
    this.#scope = new ChangesScope(store, this.#diffs);
    this.#files = new OpenFiles({
      sink,
      preview,
      threadId,
      epoch,
      diffs: this.#diffs,
      limits: options.limits ?? openFilesLimits,
      layout: () => this.#kept.layout,
      viewed: (path, version) => this.#viewedAt(path) === version,
      readPage: async (path, from, offset) => {
        const result = await this.#workspace({
          op: "git.diff",
          threadId: ThreadId.parse(this.threadId),
          path,
          ...(from === null ? {} : { from }),
          offset,
        });
        if (result.kind !== "gitDiff") throw new WorkspaceRefusal("unexpected");
        return result;
      },
    });
    this.review = new SheetReview({
      owner,
      kept: this.#kept,
      sink,
      preview,
      threadId,
      epoch,
      now: options.now ?? counter(),
      thread: () => {
        const thread = this.#store.thread;
        return thread && { id: thread.id, workspaceId: thread.workspaceId };
      },
      diffOf: (path) => this.diffOf(path),
      applied: () => void this.refresh(),
    });
    this.#details = detailsKey(store.thread?.details);
    const change: ChangeTap = (keys) => {
      const turns = keys === "all" || touchesTurns(this.#store, keys);
      if (turns) this.#scope.invalidate();
      if (keys === "all" || keys.has("thread")) {
        const next = detailsKey(this.#store.thread?.details);
        if (next !== this.#details) {
          this.#details = next;
          void this.refresh();
          if (!turns) return;
        }
      } else if (!turns) return;
      this.#update();
    };
    this.#stops.push(store.observe(change));
    // A viewed mark or the layout read back from the phone changes rows and headers.
    this.#stops.push(
      this.#kept.subscribe(() => {
        this.summary();
        this.#files.headers();
      }),
    );
    this.summary();
    void this.refresh();
  }

  get details(): ThreadDetails | undefined {
    return this.#store.thread?.details;
  }
  get reads(): Reads | undefined {
    return this.#reads;
  }

  /** Read again; overlapping requests coalesce into one more read after the current one. */
  refresh(): Promise<void> {
    if (this.#reading) {
      this.#again = true;
      return this.#reading;
    }
    this.#reading = this.#read().finally(() => {
      this.#reading = undefined;
      if (this.#again && !this.#closed) {
        this.#again = false;
        void this.refresh();
      }
    });
    return this.#reading;
  }

  /** Show only `path`'s diff, or none (the first sheet's one-file view). */
  file(path: string | undefined): void {
    this.#files.closeAll();
    if (path !== undefined) this.open(path, true);
  }

  /** Open or close one file among several; false past the limit of open files. */
  open(path: string, open: boolean): boolean {
    if (!open) {
      this.#files.close(path);
      this.summary();
      return true;
    }
    const opened = this.#files.open(path, this.#scope.sourceOf(path, this.#reads));
    this.summary();
    return opened;
  }

  /** Open every listed file (as many as may be open at once), or close them all. */
  expand(open: boolean): void {
    if (!open) this.#files.closeAll();
    else
      for (const file of this.#listed()) {
        if (this.#files.paths.length >= this.#files.limit) break;
        this.#files.open(file.path, this.#scope.sourceOf(file.path, this.#reads));
      }
    this.summary();
  }

  more(path: string): boolean {
    return this.#files.more(path);
  }
  line(path: string, index: number): boolean {
    return this.#files.line(path, index);
  }

  scope(scope: DiffScope): void {
    this.#scope.request(scope);
    this.#update();
  }

  layout(layout: DiffLayout): void {
    this.#kept.layout = layout;
    this.#files.relayout();
  }

  /** Mark a file viewed at its current diff (it closes, as on the web), or clear the mark. */
  viewed(path: string, viewed: boolean): boolean {
    const version = this.#scope.versionOf(path, this.#reads);
    if (version === undefined) return false;
    this.#kept.view(this.threadId, path, viewed ? version : undefined);
    if (viewed) this.#files.close(path);
    this.summary();
    return true;
  }

  /** `path`'s rows in the scope: as open, else diffed now (a working-tree cut file must open). */
  diffOf(path: string): DiffRows | undefined {
    const open = this.#files.diffOf(path);
    if (open) return open;
    const sourced = this.#scope.sourceOf(path, this.#reads);
    if (sourced?.source.kind === "turn") return this.#diffs.diff(sourced.source.file);
    if (sourced?.source.kind === "section") return sectionDiff(sourced.source.text);
    return undefined;
  }

  close(): void {
    this.#closed = true;
    this.drafting?.controller.abort();
    for (const stop of this.#stops) stop();
    this.#files.closeAll();
    this.review.close();
    this.#reads = undefined;
    this.#sink.clear("changes:");
  }

  summary(): void {
    if (this.#closed) return;
    this.#sink.put("changes:summary", () =>
      this.#closed
        ? undefined
        : summaryPatch({
            threadId: this.threadId,
            epoch: this.epoch,
            preview: this.#preview,
            details: this.details,
            reads: this.#reads,
            state: this.#scope.workingTree ? this.#state : "ready",
            message: this.#scope.workingTree ? this.#error : "",
            scope: this.#scope,
            turnFiles: this.#scope.workingTree ? undefined : this.#scope.turnFiles(),
            viewed: (path) => {
              const at = this.#viewedAt(path);
              return at !== undefined && at === this.#scope.versionOf(path, this.#reads);
            },
            open: this.#files.paths,
            openLimit: this.#files.limit,
            layout: this.#kept.layout,
            busy: this.busy,
          }),
    );
    this.#sink.put("changes:tree", () =>
      this.#closed
        ? undefined
        : treePatch(
            this.threadId,
            this.epoch,
            this.#preview,
            this.#scope.resolved.scope,
            this.#listed(),
          ),
    );
  }

  #listed() {
    if (!this.#scope.workingTree) return this.#scope.turnFiles();
    return (this.#reads?.files ?? []).slice(0, 200);
  }

  #viewedAt(path: string): string | undefined {
    return this.#kept.viewed.get(this.threadId)?.get(path);
  }

  /** Reads or turns moved: the list, and every open file at its new version. */
  #update(): void {
    if (this.#closed) return;
    for (const path of this.#files.paths)
      if (!this.#scope.sourceOf(path, this.#reads)) this.#files.close(path);
    this.#files.sync((path) => this.#scope.sourceOf(path, this.#reads));
    this.summary();
  }

  async #read(): Promise<void> {
    if (!this.#reads) this.#state = "loading";
    this.summary();
    const threadId = ThreadId.parse(this.threadId);
    try {
      const [status, diff, pr] = await Promise.all([
        this.#workspace({ op: "git.status", threadId }),
        this.#workspace({ op: "git.diff", threadId }),
        // Only a linked PR has a forge status; its checks and comments stay in the bridge.
        this.details?.linkedPrs?.length
          ? this.#workspace({ op: "pr.status", threadId }).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      if (this.#closed) return;
      if (status.kind !== "gitStatus" || diff.kind !== "gitDiff")
        throw new WorkspaceRefusal("unexpected");
      const sections = patchFiles(diff.patch);
      this.#reads = {
        files: status.files,
        byPath: new Map(status.files.map((file) => [file.path, file])),
        truncated: status.truncated,
        head: status.head,
        sections,
        patchTruncated: diff.truncated,
        lastPath: [...sections.keys()].at(-1),
        pr: pr?.kind === "pr" ? pr.status : null,
      };
      this.#state = "ready";
      this.#error = "";
    } catch (error) {
      if (this.#closed) return;
      this.#state = "error";
      this.#error =
        error instanceof WorkspaceRefusal && error.code !== "unexpected"
          ? error.code
          : "unavailable";
    }
    this.#update();
  }

  async #workspace(operation: WorkspaceActionRequest["operation"]) {
    const reply = await this.#owner.request({ type: "workspace.request", operation });
    if (reply.result.kind === "error") throw new WorkspaceRefusal(reply.result.code);
    return reply.result;
  }
}
