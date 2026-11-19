import {
  ForgeRepository,
  WorkspaceId,
  verifyMergeLimit,
  verifySettled,
  type VerifyOperation,
  type VerifyResult,
  type VerifyRun,
  type VerifyTarget,
} from "@ace/protocol";
import {
  mergePickBlocked,
  mergePickWords,
  mergeRunMethods,
  mergeRunRefusal,
  mergeSelection,
  mergeStartRefusal,
  runWords,
  shownMergeRun,
} from "@ace/ui-core";
import { z } from "zod";
import type { ForgeOwner } from "./forge-reads.ts";

/*
 * The verified merge of several pull requests from the phone's Pull requests list, as the web's
 * merge strip runs it (ADR 0094): ready rows are picked, "Verify and merge 3 pull requests into
 * main · Squash · Start" sends one `verify.request` merge run with each head as the list read
 * it, and the strip follows the run to its ending. Reads are kept under the `verify` family,
 * which `verify.changed` puts out of date, so the phone reads the run again as it moves. Which
 * run shows and every word are the shared rules' (`merge-run-words`); the bridge remembers only
 * the run started here and the ones dismissed, as the web's strip does.
 */

const projectId = z.string().min(1).max(512);
const runId = z.string().min(1).max(64);
/** A ready row as the list read it: the head a merge run is pinned to. */
export const MergePick = z.object({
  /** The row's key in the list. */
  key: z.string().min(1).max(600),
  repository: ForgeRepository,
  number: z.number().int().positive(),
  headSha: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
  base: z.string().min(1).max(256),
  title: z.string().max(512),
});
export type MergePick = z.infer<typeof MergePick>;

/** A ready row on show, as the list reads it now. */
const ReadyRow = z.object({
  key: z.string().min(1).max(600),
  base: z.string().max(256),
  /** The head the list shows now: a pick made at another one leaves the selection. */
  headSha: MergePick.shape.headSha.optional(),
});
export const ForgeMergeRunRequest = z.object({
  type: z.literal("forge.merge-run"),
  project: projectId,
  /** The rows picked, in list order. */
  picked: z.array(MergePick).max(verifyMergeLimit),
  /** Every ready row on show, for why one can't join the selection now. */
  rows: z.array(ReadyRow).max(500),
});
export type ForgeMergeRunRequest = z.infer<typeof ForgeMergeRunRequest>;

export const ForgeMergeRunWriteRequest = z.object({
  type: z.literal("forge.merge-run.write"),
  project: projectId,
  op: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("start"),
      method: z.enum(["squash", "merge", "rebase"]),
      prs: z.array(MergePick).min(1).max(verifyMergeLimit),
      /** The ready rows on show at the press: a pick whose head moved, or whose row left, starts nothing. */
      rows: z.array(ReadyRow).max(500).optional(),
    }),
    z.object({ kind: z.enum(["stop", "again", "dismiss"]), runId }),
    z.object({ kind: z.literal("without"), runId, pr: z.number().int().positive() }),
  ]),
});
export type ForgeMergeRunWriteRequest = z.infer<typeof ForgeMergeRunWriteRequest>;

export interface MergeRunAction {
  /** stop, dismiss, again, without, log, open or command. */
  kind: string;
  label: string;
  /** The pull request `without` drops or `open` opens. */
  pr: number | null;
  /** Where `open`'s pull request lives. */
  repository: ForgeRepository | null;
}
export interface MergeRunReply {
  type: "forge.merge-run";
  /**
   * What the picked rows offer while no run shows. `start` is false when there's no check
   * command, or when Verify refused the list; then `refusal` says why, in the web's words, and
   * the strip offers no "Set a check command" that couldn't help.
   */
  pick: { sentence: string; start: boolean; refusal: string | null } | null;
  /** The picks still selected, in list order: each at the head it was picked at. */
  picked: string[];
  /** Picks whose head moved since, said once: they leave the selection. */
  notice: string | null;
  /** Each ready row that can't join the selection now, and why. */
  blocked: { key: string; reason: string }[];
  /** The run the strip shows: its sentence, since when it has run while live, its actions. */
  run: {
    id: string;
    sentence: string;
    since: number | null;
    /** It has ended; a new selection takes its place. */
    settled: boolean;
    actions: MergeRunAction[];
  } | null;
  /** A run that merged something, by id: the list is read again once for it. */
  merged: string | null;
  methods: { value: string; label: string }[];
}
export interface MergeRunWriteReply {
  type: "forge.write";
  ok: boolean;
  message: string;
}

/** What the strip remembers per project: the run started here and the ones dismissed. */
export class MergeRunMemory {
  readonly #own = new Map<string, string>();
  readonly #dismissed = new Map<string, Set<string>>();
  own(project: string): string | undefined {
    return this.#own.get(project);
  }
  dismissed(project: string): ReadonlySet<string> {
    return this.#dismissed.get(project) ?? new Set();
  }
  started(project: string, id: string): void {
    this.#own.set(project, id);
  }
  forget(project: string, id: string): void {
    const dismissed = this.#dismissed.get(project) ?? new Set<string>();
    // Ids are kept for the strip's newest runs only; older ones never show again anyway.
    dismissed.add(id);
    if (dismissed.size > 200) dismissed.delete(dismissed.values().next().value ?? id);
    this.#dismissed.set(project, dismissed);
    if (this.#own.get(project) === id) this.#own.delete(project);
  }
}

function verify(owner: ForgeOwner, op: VerifyOperation): Promise<VerifyResult> {
  return owner.request({ type: "verify.request", op }, { timeoutMs: 15_000 });
}

/**
 * The project's runs and check command; a refused list is kept as its refusal, never read as a
 * project with no command.
 */
async function listed(
  owner: ForgeOwner,
  project: string,
): Promise<
  { ok: true; runs: VerifyRun[]; command: string | null } | { ok: false; refusal: string }
> {
  const reply = await verify(owner, { action: "list", workspaceId: WorkspaceId.parse(project) });
  if (!reply.ok) return { ok: false, refusal: mergeRunRefusal(reply.error) };
  return { ok: true, runs: reply.runs ?? [], command: reply.command ?? null };
}

function runView(run: VerifyRun, base: string): NonNullable<MergeRunReply["run"]> {
  const words = runWords(run, base);
  const where = (pr: number) =>
    run.target.kind === "merge"
      ? (run.target.prs.find((each) => each.pr.number === pr)?.pr.repository ?? null)
      : null;
  return {
    id: run.id,
    sentence: words.sentence,
    since: words.since ?? null,
    settled: verifySettled.includes(run.state),
    actions: words.actions.map((action) => {
      const pr = "pr" in action ? action.pr : null;
      return {
        kind: action.kind,
        label: action.label,
        pr,
        repository: action.kind === "open" && pr !== null ? where(pr) : null,
      };
    }),
  };
}

export async function readMergeRun(
  owner: ForgeOwner,
  memory: MergeRunMemory,
  request: ForgeMergeRunRequest,
): Promise<MergeRunReply> {
  const list = await listed(owner, request.project);
  const runs = list.ok ? list.runs : [];
  const state = { dismissed: memory.dismissed(request.project), own: memory.own(request.project) };
  // Picks keep the head they were picked at; one whose row moved on leaves the selection.
  const selection = mergeSelection(request.picked, request.rows);
  const chosen = selection.kept;
  const base = chosen[0]?.base;
  const shown = shownMergeRun(runs, { ...state, picking: chosen.length > 0 });
  const latest = shownMergeRun(runs, { ...state, picking: false });
  const picked = new Set(chosen.map((pick) => pick.key));
  return {
    type: "forge.merge-run",
    pick:
      !shown && base !== undefined
        ? {
            sentence: mergePickWords(chosen.length, base),
            start: list.ok && list.command !== null,
            refusal: list.ok ? null : list.refusal,
          }
        : null,
    picked: chosen.map((pick) => pick.key),
    notice: selection.notice ?? null,
    blocked: request.rows.flatMap((row) => {
      const reason = mergePickBlocked({
        picked: picked.has(row.key),
        count: chosen.length,
        base,
        rowBase: row.base,
      });
      return reason ? [{ key: row.key, reason }] : [];
    }),
    run: shown ? runView(shown, base ?? "main") : null,
    merged:
      latest && verifySettled.includes(latest.state) && latest.merged.length > 0 ? latest.id : null,
    methods: [...mergeRunMethods],
  };
}

const done = (ok: boolean, message = ""): MergeRunWriteReply => ({
  type: "forge.write",
  ok,
  message,
});

export async function writeMergeRun(
  owner: ForgeOwner,
  memory: MergeRunMemory,
  request: ForgeMergeRunWriteRequest,
): Promise<MergeRunWriteReply> {
  const { op } = request;
  if (op.kind === "dismiss") {
    memory.forget(request.project, op.runId);
    return done(true);
  }
  const start = async (next: VerifyTarget) => {
    const reply = await verify(owner, {
      action: "start",
      workspaceId: WorkspaceId.parse(request.project),
      target: next,
    });
    if (!reply.ok) return done(false, mergeRunRefusal(reply.error));
    if (reply.run) memory.started(request.project, reply.run.id);
    return done(true);
  };
  try {
    if (op.kind === "start") {
      // A pick whose head moved, or whose row left the list, is picked again first.
      const refused = op.rows ? mergeStartRefusal(op.prs, op.rows) : undefined;
      if (refused) return done(false, refused);
      return await start({
        kind: "merge",
        method: op.method,
        prs: op.prs.map((pick) => ({
          pr: { repository: pick.repository, number: pick.number },
          headSha: pick.headSha,
          title: pick.title,
        })),
      });
    }
    if (op.kind === "stop") {
      const reply = await verify(owner, { action: "cancel", runId: op.runId });
      return reply.ok ? done(true) : done(false, mergeRunRefusal(reply.error));
    }
    const list = await listed(owner, request.project);
    if (!list.ok) return done(false, list.refusal);
    const from = list.runs.find((run) => run.id === op.runId);
    if (from?.target.kind !== "merge") return done(false, "That run is gone. Pick again.");
    memory.forget(request.project, from.id);
    const prs =
      op.kind === "without"
        ? from.target.prs.filter((each) => each.pr.number !== op.pr)
        : from.target.prs;
    return await start({ ...from.target, prs });
  } catch {
    return done(false, mergeRunRefusal(undefined));
  }
}
