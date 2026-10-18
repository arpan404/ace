import type { ChangeTap, ClientCore, ThreadSource } from "@ace/client";
import {
  ThreadId,
  type ForgePrStatus,
  type GitStatusFile,
  type SourceControlSelection,
  type ThreadDetails,
  type WorkspaceActionRequest,
} from "@ace/protocol";
import {
  changesNextStep,
  changesSummary,
  mobileDiffBudget,
  mergeMethods,
  mobileFileDiff,
  patchFiles,
  type DiffBudget,
} from "@ace/ui-core/mobile";
import type { PatchSink, Preview } from "./agents.ts";

/** What the Changes sheet needs of the SDK: correlated reads and online commands. */
export type ChangesOwner = Pick<ClientCore, "request" | "command">;
export type ChangesStore = Pick<ThreadSource, "thread" | "observe">;

interface Reads {
  files: readonly GitStatusFile[];
  truncated: boolean;
  head: string | null | undefined;
  sections: Map<string, string>;
  /** The daemon cut the patch at its cap: the last file's section may be incomplete. */
  patchTruncated: boolean;
  lastPath: string | undefined;
  pr: ForgePrStatus | null;
}

/** A refusal code from the daemon's workspace service, kept for the shared copy table. */
export class WorkspaceRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
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

/**
 * The Changes sheet while it is open. The bridge holds the daemon's bounded reads (at most
 * 500 status rows and a 256 KiB patch) and ships a capped file list, the next step, and one
 * file's diff at a time within `mobileDiffBudget`. Closing releases all of it.
 */
export class ChangesSession {
  readonly threadId: string;
  readonly epoch: number;
  #owner: ChangesOwner;
  #store: ChangesStore;
  #sink: PatchSink;
  #preview: Preview;
  #budget: DiffBudget;
  #reads: Reads | undefined;
  #state: "loading" | "ready" | "error" = "loading";
  #error = "";
  #reading: Promise<void> | undefined;
  #again = false;
  #closed = false;
  #path: string | undefined;
  #details: string;
  #stop: () => void;
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
    budget: DiffBudget = mobileDiffBudget,
  ) {
    this.#owner = owner;
    this.#store = store;
    this.threadId = threadId;
    this.epoch = epoch;
    this.#sink = sink;
    this.#preview = preview;
    this.#budget = budget;
    this.#details = detailsKey(store.thread?.details);
    const change: ChangeTap = (keys) => {
      if (keys !== "all" && !keys.has("thread")) return;
      const next = detailsKey(this.#store.thread?.details);
      if (next !== this.#details) {
        this.#details = next;
        void this.refresh();
      } else this.summary();
    };
    this.#stop = store.observe(change);
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

  /** Show one file's diff; it follows refreshes until another file or none is chosen. */
  file(path: string | undefined): void {
    this.#path = path;
    if (path === undefined) {
      this.#sink.clear("changes:file");
      return;
    }
    this.#putFile(path);
  }

  close(): void {
    this.#closed = true;
    this.drafting?.controller.abort();
    this.#stop();
    this.#reads = undefined;
    this.#sink.clear("changes:");
  }

  summary(): void {
    if (this.#closed) return;
    this.#sink.put("changes:summary", () => {
      const reads = this.#reads;
      const summary = reads ? changesSummary(reads.files, reads.truncated) : undefined;
      const step = changesNextStep(this.details, reads?.pr, summary?.totals);
      return {
        type: "changes.summary",
        threadId: this.threadId,
        epoch: this.epoch,
        state: this.#state,
        message: this.#error,
        files: (summary?.files ?? []).map((file) =>
          Object.assign(file, {
            path: this.#preview(file.path, 1024),
            from: file.from === null ? null : this.#preview(file.from, 1024),
          }),
        ),
        hidden: summary?.hidden ?? 0,
        partial: summary?.partial ?? false,
        totals: summary?.totals ?? { files: 0, additions: 0, deletions: 0 },
        patchTruncated: reads?.patchTruncated ?? false,
        branch: this.#preview(this.details?.branch ?? "", 256),
        step: {
          ...step,
          label: this.#preview(step.label, 128),
          detail: this.#preview(step.detail, 512),
          blocked: step.blocked === null ? null : this.#preview(step.blocked, 512),
          pr: step.pr && { ...step.pr, title: step.pr.title && this.#preview(step.pr.title, 256) },
        },
        busy: this.busy,
        // Every way the forge merges; the phone remembers the last one picked.
        methods: mergeMethods.map((each) => ({ method: each.method, label: each.label })),
      };
    });
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
    this.summary();
    if (this.#path !== undefined) this.#putFile(this.#path);
  }

  async #workspace(operation: WorkspaceActionRequest["operation"]) {
    const reply = await this.#owner.request({ type: "workspace.request", operation });
    if (reply.result.kind === "error") throw new WorkspaceRefusal(reply.result.code);
    return reply.result;
  }

  #putFile(path: string): void {
    this.#sink.put("changes:file", () => {
      const reads = this.#reads;
      if (!reads || this.#path !== path) return undefined;
      const section = reads.sections.get(path);
      // A file missing from a cut patch, or the file the cut fell in, may be incomplete.
      const cut = reads.patchTruncated && (section === undefined || reads.lastPath === path);
      return {
        type: "changes.file",
        threadId: this.threadId,
        epoch: this.epoch,
        path: this.#preview(path, 1024),
        diff: mobileFileDiff(section, cut, this.#budget, this.#preview),
      };
    });
  }
}
