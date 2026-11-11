import { z } from "zod";
import { Buffer } from "node:buffer";
import {
  ForgePrRef,
  ForgeRepository,
  originApiHost,
  type ForgePrStatus as ForgePrStatusType,
} from "@ace/protocol/forge";
import {
  ForgeFilePageInput,
  ForgePrDetail,
  ForgePrFiles,
  ForgePrList,
  ForgePrSearch,
  type ForgePrDetail as ForgePrDetailType,
  type ForgePrFiles as ForgePrFilesType,
  type ForgePrList as ForgePrListType,
} from "@ace/protocol/forge-browser";
import { ForgePrCheckout } from "@ace/protocol/forge-worktree";
import type { ForgeReader } from "./api.ts";
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { clipLabels, clipText } from "./host-text.ts";
import { OriginListSnapshots, type OriginListSnapshot } from "./origin-list-snapshots.ts";
import { prUrl } from "./pr-reference.ts";
import {
  FILES_MAX_ITEMS,
  FILES_MAX_STEPS,
  FILES_PAGE_SIZE,
  LIST_MAX_ITEMS,
  LIST_MAX_STEPS,
  LIST_PAGE_SIZE,
  OriginError,
  OriginFilesPage,
  OriginPr,
  OriginPrList,
  ROW_PAGE_SIZE,
  authorOf,
  lowerSha,
  safeNumber,
  stateOf,
  type OriginFile,
  type OriginLifecycle,
  type OriginPr as OriginPrRecord,
  type OriginPrState,
} from "./origin-records.ts";
import { ReadBudget } from "./read-budget.ts";
import { redactData } from "./redact.ts";

const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);

/** Protocol outputs never leak host fields as a raw ZodError. */
function checked<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError("invalid_data");
  }
}

/** Read-only Cursor Origin pull request adapter over the user's `origin` CLI.
 * Primary docs: cursor.com/docs/api/origin (GET /repos/{owner}/{repo}/pulls,
 * GET .../pulls/{n}, GET .../pulls/{n}/files) and
 * cursor.com/docs/origin/cli/reference/commands (`origin api`, `--method`).
 * No mutations; the caller's runner already verified CLI identity. */
export class OriginReader implements ForgeReader {
  readonly repository: ForgeRepository;
  readonly #runner: CommandRunner;
  readonly #base: string;
  readonly #snapshots: OriginListSnapshots | undefined;

  /** `snapshots` lets list page turns reuse one traversal; it must be scoped to the runner's
   * admitted account. Without it every list read traverses again. */
  constructor(options: {
    repository: ForgeRepository;
    runner: CommandRunner;
    snapshots?: OriginListSnapshots | undefined;
  }) {
    this.repository = checked(() => ForgeRepository.parse(options.repository));
    if (this.repository.forge !== "origin") throw new ForgeError("unsupported");
    if (this.repository.host !== originApiHost) throw new ForgeError("unsupported");
    if (!options.runner) throw new ForgeError("unsupported");
    this.#runner = options.runner;
    this.#snapshots = options.snapshots;
    this.#base = `/repos/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.name)}`;
  }

  #ref(number: number): { repository: ForgeRepository; number: number } {
    return checked(() => ForgePrRef.parse({ repository: this.repository, number }));
  }

  /** The server's web URL only when it names this pull request on cursor.com without
   * credentials; otherwise the canonical https://cursor.com/codebase/o/r/pull/17 shape. */
  #webUrl(pr: OriginPrRecord, number: number): string {
    const canonical = prUrl({ repository: this.repository, number });
    if (typeof pr.webUrl === "string") {
      try {
        const url = new URL(pr.webUrl);
        if (
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === "" &&
          (url.host === "cursor.com" || url.host === "www.cursor.com") &&
          url.pathname ===
            `/codebase/${this.repository.owner}/${this.repository.name}/pull/${number}`
        )
          return pr.webUrl;
      } catch {
        /* Fall through to the canonical URL. */
      }
    }
    return canonical;
  }

  /** One explicit GET through `origin api`; stdout/stderr/credentials never leave as errors. */
  async #get(endpoint: string, signal: AbortSignal, budget: ReadBudget): Promise<unknown> {
    signal.throwIfAborted();
    let result;
    try {
      result = await this.#runner({
        command: "origin",
        args: ["api", endpoint, "--method", "GET"],
        signal,
        mode: "json",
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ForgeError) throw error;
      throw new ForgeError("cli");
    }
    signal.throwIfAborted();
    if (result.truncated) throw new ForgeError("limit");
    if (result.unreachable) throw new ForgeError("offline");
    if (result.code !== 0) throw OriginReader.#cliError(result.stdout);
    budget.add(Buffer.byteLength(result.stdout, "utf8"));
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new ForgeError("invalid_data");
    }
  }

  /** CLI failures stay fixed categories; stdout itself never escapes. */
  static #cliError(stdout: string): ForgeError {
    try {
      const parsed = OriginError.parse(JSON.parse(stdout));
      const message = parsed.message ?? "";
      if (parsed.code === 8 || /rate limit|resource exhausted|retry after/i.test(message))
        return new ForgeError("rate_limit");
      if (
        parsed.code === 7 ||
        parsed.code === 16 ||
        /unauthenticated|permission denied|forbidden|not signed|sign in|allowlist/i.test(message)
      )
        return new ForgeError("forbidden");
      if (parsed.code === 5 || /not found|not available/i.test(message))
        return new ForgeError("not_found");
      if (parsed.code === 3) return new ForgeError("invalid_data");
    } catch {
      /* Unparseable failure output is just a CLI failure. */
    }
    return new ForgeError("cli");
  }

  /** One pull request by number; the number must match what was asked for. */
  async #pr(number: number, signal: AbortSignal, budget: ReadBudget): Promise<OriginPr> {
    this.#ref(number);
    const result = OriginPr.safeParse(
      await this.#get(`${this.#base}/pulls/${number}`, signal, budget),
    );
    if (!result.success || safeNumber(result.data.number) !== number)
      throw new ForgeError("invalid_data");
    return result.data;
  }

  #statusOf(pr: OriginPrRecord, number: number): ForgePrStatusType {
    const headSha = lowerSha(pr.head.sha);
    if (headSha === null) throw new ForgeError("invalid_data");
    return checked(() =>
      ForgePrDetail.shape.status.parse({
        ref: this.#ref(number),
        title: clipText(pr.title),
        url: this.#webUrl(pr, number),
        headSha,
        state: stateOf(pr),
        mergeability: "unknown",
        ci: "unknown",
        checks: [],
        comments: [],
        reviewThreads: [],
        raw: redactData(pr),
      }),
    );
  }

  async status(number: number, signal: AbortSignal): Promise<ForgePrStatusType> {
    return this.#statusOf(await this.#pr(number, signal, new ReadBudget()), number);
  }

  async listPrs(query: ForgePrSearch, signal: AbortSignal): Promise<ForgePrListType> {
    const q = checked(() => ForgePrSearch.parse(query));
    if (q.ci !== "any" || q.review !== "any") throw new ForgeError("unsupported");
    if (q.author !== "" || q.reviewer !== "" || q.assignee !== "")
      throw new ForgeError("unsupported");
    if (q.sort === "comments") throw new ForgeError("unsupported");
    const labels = [
      ...new Set(q.labels.map((label) => label.trim()).filter((label) => label !== "")),
    ];
    if (labels.length > 10) throw new ForgeError("unsupported");
    const budget = new ReadBudget();
    const params = new URLSearchParams({
      state: "all",
      sortBy: q.sort === "created" ? "created" : "updated",
      direction: q.order,
      pageSize: String(LIST_PAGE_SIZE),
    });
    for (const label of labels) params.append("labels", label);
    const prefix = `${this.#base}/pulls?${params}`;
    const { records: collected, capped } =
      this.#snapshots?.get(prefix) ?? (await this.#collect(prefix, signal, budget));
    const needle = q.search.trim().toLowerCase();
    const matches = (pr: OriginPrRecord): boolean => {
      if (needle === "") return true;
      return `${pr.title}\n${pr.body ?? ""}\n${pr.head.ref}\n${pr.base.ref}`
        .toLowerCase()
        .includes(needle);
    };
    const wanted = (state: OriginPrState): boolean => {
      if (q.state === "open") return state === "open";
      if (q.state === "draft") return state === "draft";
      if (q.state === "active") return state === "open" || state === "draft";
      if (q.state === "closed") return state === "closed";
      if (q.state === "merged") return state === "merged";
      return true;
    };
    const counts = { open: 0, draft: 0, closed: 0, merged: 0 };
    const filtered: { pr: OriginPrRecord; state: OriginPrState }[] = [];
    // A state rows can't express is dropped and the list marked incomplete, never shown open.
    let skipped = false;
    for (const pr of collected) {
      const state: OriginLifecycle = stateOf(pr);
      if (state === "unknown") {
        skipped = true;
        continue;
      }
      counts[state] += 1;
      if (wanted(state) && matches(pr)) filtered.push({ pr, state });
    }
    const rows = filtered
      .slice((q.page - 1) * ROW_PAGE_SIZE, q.page * ROW_PAGE_SIZE)
      .map(({ pr, state }) => {
        const number = safeNumber(pr.number);
        if (number === null) throw new ForgeError("invalid_data");
        const headSha = lowerSha(pr.head.sha);
        return Object.assign(
          {
            raw: redactData(pr),
            ref: this.#ref(number),
            title: clipText(pr.title),
            url: this.#webUrl(pr, number),
            author: clipText(authorOf(pr)),
            state,
            labels: clipLabels(pr.labels?.map((label) => label.name)),
            updatedAt: pr.updatedAt,
            createdAt: pr.createdAt,
            headBranch: clipText(pr.head.ref),
            baseBranch: clipText(pr.base.ref),
          },
          headSha === null ? {} : { headSha },
          pr.additions !== undefined ? { additions: pr.additions } : {},
          pr.deletions !== undefined ? { deletions: pr.deletions } : {},
        );
      });
    const total = filtered.length;
    return checked(() =>
      ForgePrList.parse({
        repository: this.repository,
        items: rows,
        total,
        ...(q.page * ROW_PAGE_SIZE < total ? { nextPage: q.page + 1 } : {}),
        counts,
        incomplete: capped || skipped,
        truncated: capped,
      }),
    );
  }

  /** Every pull request under one list request, up to the 1000-record bound, kept as a
   * snapshot for page turns when the owner supplied one. */
  async #collect(
    prefix: string,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<OriginListSnapshot> {
    const collected: OriginPrRecord[] = [];
    let pageToken = "";
    let capped = false;
    for (let step = 0; step < LIST_MAX_STEPS; step++) {
      signal.throwIfAborted();
      const endpoint =
        pageToken === "" ? prefix : `${prefix}&pageToken=${encodeURIComponent(pageToken)}`;
      const envelope = OriginPrList.safeParse(await this.#get(endpoint, signal, budget));
      if (!envelope.success) throw new ForgeError("invalid_data");
      for (const item of envelope.data.pullRequests) {
        if (safeNumber(item.number) === null) throw new ForgeError("invalid_data");
        collected.push(item);
      }
      pageToken = envelope.data.nextPageToken?.trim() ? envelope.data.nextPageToken : "";
      if (collected.length >= LIST_MAX_ITEMS) {
        collected.length = LIST_MAX_ITEMS;
        capped = pageToken !== "";
        break;
      }
      if (pageToken === "") break;
      if (step === LIST_MAX_STEPS - 1) capped = true;
    }
    const snapshot = { records: collected, capped };
    this.#snapshots?.set(prefix, snapshot);
    return snapshot;
  }

  async prDetail(number: number, signal: AbortSignal): Promise<ForgePrDetailType> {
    const pr = await this.#pr(number, signal, new ReadBudget());
    const baseSha = lowerSha(pr.base.sha);
    if (baseSha === null) throw new ForgeError("invalid_data");
    return checked(() =>
      ForgePrDetail.parse({
        readOnly: true,
        unavailableResources: ["comments", "checks", "reviews", "commits"],
        status: this.#statusOf(pr, number),
        updatedAt: pr.updatedAt,
        createdAt: pr.createdAt,
        ...(pr.additions !== undefined ? { additions: pr.additions } : {}),
        ...(pr.deletions !== undefined ? { deletions: pr.deletions } : {}),
        body: clipText(pr.body ?? ""),
        author: clipText(authorOf(pr)),
        headBranch: clipText(pr.head.ref),
        baseBranch: clipText(pr.base.ref),
        baseSha,
        headRepository: this.repository,
        labels: clipLabels(pr.labels?.map((label) => label.name)),
        reviewers: [],
        reviewDecision: null,
        commits: 0,
        changedFiles: pr.changedFiles ?? 0,
        relatedThreads: [],
        relatedThreadsTruncated: false,
      }),
    );
  }

  /** The version's SHAs must still equal the requested pin, before and after the read. */
  #assertPinned(pr: OriginPrRecord, pinned: { headSha: string; baseSha: string }): void {
    const head = pr.version?.headSha ?? pr.head.sha;
    const base = pr.version?.baseSha ?? pr.base.sha;
    if (
      head.toLowerCase() !== pinned.headSha.toLowerCase() ||
      base.toLowerCase() !== pinned.baseSha.toLowerCase()
    )
      throw new ForgeError("head_moved");
  }

  async prFiles(
    input: {
      number: number;
      page: number;
      headSha: string;
      baseSha: string;
      commit?: string | undefined;
      since?: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<ForgePrFilesType> {
    checked(() => ForgeFilePageInput.parse(input));
    const pinned = checked(() =>
      ForgePrFiles.pick({ headSha: true, baseSha: true, commit: true, since: true }).parse(input),
    );
    if (pinned.commit !== undefined || pinned.since !== undefined)
      throw new ForgeError("unsupported");
    if (!sha.safeParse(pinned.headSha).success || !sha.safeParse(pinned.baseSha).success)
      throw new ForgeError("invalid_data");
    const budget = new ReadBudget();
    this.#assertPinned(await this.#pr(input.number, signal, budget), pinned);
    const prefix = `${this.#base}/pulls/${input.number}/files?pageSize=${FILES_PAGE_SIZE}`;
    const records: OriginFile[] = [];
    let pageToken = "";
    let truncated = false;
    for (let step = 0; step < FILES_MAX_STEPS; step++) {
      signal.throwIfAborted();
      const endpoint =
        pageToken === "" ? prefix : `${prefix}&pageToken=${encodeURIComponent(pageToken)}`;
      const envelope = OriginFilesPage.safeParse(await this.#get(endpoint, signal, budget));
      if (!envelope.success) throw new ForgeError("invalid_data");
      records.push(...envelope.data.files);
      pageToken = envelope.data.nextPageToken?.trim() ? envelope.data.nextPageToken : "";
      if (records.length >= FILES_MAX_ITEMS) {
        records.length = FILES_MAX_ITEMS;
        truncated = pageToken !== "";
        break;
      }
      if (pageToken === "") break;
      if (step === FILES_MAX_STEPS - 1) truncated = true;
    }
    this.#assertPinned(await this.#pr(input.number, signal, budget), pinned);
    const files = records
      .slice((input.page - 1) * ROW_PAGE_SIZE, input.page * ROW_PAGE_SIZE)
      .map((file) => {
        const patch = file.patch ?? null;
        const kept = patch === null ? null : patch.slice(0, 262_144);
        const patchTruncated = patch !== null && patch.length > 262_144;
        return Object.assign(
          {
            raw: redactData(Object.assign({}, file, { patch: kept })),
            path: clipText(file.filename),
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch: kept,
            truncated: patchTruncated || truncated,
          },
          file.previousFilename !== undefined && file.previousFilename !== file.filename
            ? { previousPath: clipText(file.previousFilename) }
            : {},
        );
      });
    return checked(() =>
      ForgePrFiles.parse({
        ref: this.#ref(input.number),
        baseSha: pinned.baseSha,
        headSha: pinned.headSha,
        files,
        ...(input.page * ROW_PAGE_SIZE < records.length ||
        (truncated && input.page * ROW_PAGE_SIZE < FILES_MAX_ITEMS)
          ? { nextPage: input.page + 1 }
          : {}),
        truncated,
      }),
    );
  }

  async prCheckout(number: number, signal: AbortSignal) {
    const pr = await this.#pr(number, signal, new ReadBudget());
    const headSha = lowerSha(pr.head.sha);
    const baseSha = lowerSha(pr.base.sha);
    if (headSha === null || baseSha === null) throw new ForgeError("invalid_data");
    signal.throwIfAborted();
    return checked(() =>
      ForgePrCheckout.parse({
        ref: this.#ref(number),
        headSha,
        baseSha,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        headRepository: this.repository,
      }),
    );
  }
}
