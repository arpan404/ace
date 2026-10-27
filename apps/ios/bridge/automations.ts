import type { ClientCore } from "@ace/client";
import { Automation, AutomationRequest, AutomationSource, type AutomationRun } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import {
  automationErrorMessage,
  automationLists,
  describeWhen,
  duplicateAutomation,
  historyPollMs,
  nextRunText,
  automationsOffFix,
  automationsOffText,
  runSummary,
  runTurn,
  savedBefore,
  sidebarRow,
  triggerErrorCopy,
  githubHint,
  type AutomationEntry,
} from "@ace/ui-core/automations";
import { type NewThreadAgents } from "@ace/ui-core/mobile";
import type { ThreadStatus } from "@ace/protocol";
import { z } from "zod";
import {
  formOpen,
  formPreview,
  formSave,
  FormSave,
  FormOpen,
  FormPreview,
} from "./automation-form.ts";

/*
 * The phone's Automations screens as ready-made rows (ADR 0015): the list with each one's status
 * and next start, an automation's runs as turns linked to their threads, the editor's form
 * (`automation-form.ts`) and Duplicate. Every word and rule comes from `@ace/ui-core/automations`,
 * the same module the web app draws with; Swift only draws and sends intents.
 */

const id = z.string().min(1).max(256);
/** The phone's own IANA zone, so "Tonight 2:00 AM" reads on its clock. */
const Zone = z.string().min(1).max(128).optional();

export const AutomationsPageRequest = z.object({
  type: z.literal("automations.page"),
  zone: Zone,
});
export const AutomationsHistoryRequest = z.object({
  type: z.literal("automations.history"),
  automationId: id,
  source: AutomationSource.optional(),
  /** The cursor the last page gave, for older runs. */
  before: z.number().int().positive().optional(),
  zone: Zone,
});
export const AutomationsDuplicateRequest = z.object({
  type: z.literal("automations.duplicate"),
  automation: Automation,
  /** The copy's id, made on the phone. */
  id,
});
/** Undo a Delete: the automation as it was, made again under its own id. */
export const AutomationsRestoreRequest = z.object({
  type: z.literal("automations.restore"),
  automation: Automation,
});
/** Run now (with a note), Pause or Resume, Retry a stopped trigger, Delete. */
export const AutomationsWriteRequest = z.object({
  type: z.literal("automations.write"),
  request: z.record(z.string(), z.unknown()),
});
const writes = new Set([
  "automation.run",
  "automation.setEnabled",
  "automation.retry",
  "automation.remove",
]);
export const NativeAutomationRequest = z.union([
  AutomationsWriteRequest,
  AutomationsPageRequest,
  AutomationsHistoryRequest,
  AutomationsDuplicateRequest,
  AutomationsRestoreRequest,
  FormOpen,
  FormPreview,
  FormSave,
]);
export type NativeAutomationRequest = z.infer<typeof NativeAutomationRequest>;

export interface AutomationsDeps {
  owner: Pick<ClientCore, "request">;
  now(): number;
  /** The phone's zone when a request names none. */
  zone(): string;
  /** The coding agents New thread read, read again when none are known yet. */
  agents(): Promise<NewThreadAgents | undefined>;
  /** A thread's whole-tree state as this phone's thread list holds it. */
  threadState(threadId: string): ThreadStatus["state"] | undefined;
  /** The project's GitHub repository, "owner/name", for a GitHub trigger to start from. */
  repository(workspace: string): Promise<string | undefined>;
}

type Reply = Record<string, unknown> & { ok: boolean };
const refused = (code: string | undefined): Reply => ({
  ok: false,
  error: automationErrorMessage(code),
});
const timeout = { timeoutMs: 20_000 };

/** The project's folder name, "ace-next" for "/Users/me/ace-next". */
const folderName = (path: string) => path.split(/[\\/]/).findLast(Boolean) ?? path;

/** What needs the person about an automation, as one sentence: a stopped trigger, a GitHub check. */
function attention(entry: AutomationEntry) {
  if (!entry.automation.enabled) return null;
  if (entry.triggerError)
    return {
      word: "Not watching",
      text: triggerErrorCopy(entry.automation.trigger, entry.triggerError),
      at: entry.triggerError.at,
      retry: true,
    };
  if (entry.lastPollError)
    return {
      word: "Couldn't check GitHub",
      text: githubHint(entry.lastPollError.message),
      at: entry.lastPollError.at,
      retry: false,
    };
  return null;
}

export function automationRow(
  entry: AutomationEntry,
  now: number,
  zone: string,
  threadState: AutomationsDeps["threadState"] = () => undefined,
  /** Whether the machine runs automations; undefined while unknown. */
  running?: boolean,
) {
  const { automation } = entry;
  const row = sidebarRow(entry, now, zone);
  const run = entry.lastRun;
  // A run waiting on the person is loud on its row, never a quiet "Running".
  const asking =
    automation.enabled &&
    run?.status === "running" &&
    !!run.threadId &&
    threadState(run.threadId) === "needs_you";
  return {
    id: automation.id,
    title: automation.title,
    enabled: automation.enabled,
    source: entry.owner === undefined ? "person" : "thread",
    owner: entry.owner ?? null,
    revision: entry.revision ?? null,
    automation,
    status: asking ? { tone: "needs-you", word: "Needs you" } : (row.status ?? null),
    detail: row.detail,
    when: describeWhen(automation.trigger, zone),
    next: nextRunText(automation, entry.nextRunAt, now, zone, running),
    attention: attention(entry),
    lastRun: entry.lastRun
      ? { status: entry.lastRun.status, text: runSummary(entry.lastRun) }
      : null,
    project: folderName(automation.workspace),
    agent: providerNames[automation.provider],
    model: automation.model ?? null,
    kind: automation.trigger.kind,
  };
}

/** One run as the phone draws it: its turn, plus whether its thread still waits on the person. */
export function runRow(
  run: AutomationRun,
  now: number,
  zone: string,
  threadState: AutomationsDeps["threadState"],
) {
  const waits =
    run.status === "running" && !!run.threadId && threadState(run.threadId) === "needs_you";
  const turn = runTurn(run, now, zone, waits);
  return {
    id: run.id,
    status: run.status,
    threadId: run.threadId ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    when: turn.when,
    head: turn.status ?? null,
    detail: turn.detail ?? null,
    note: turn.note ?? null,
    live: turn.live,
    body: turn.body ?? null,
    muted: turn.muted,
    runAgain: turn.runAgain,
  };
}

export class NativeAutomations {
  readonly #deps: AutomationsDeps;
  constructor(deps: AutomationsDeps) {
    this.#deps = deps;
  }

  async answer(request: NativeAutomationRequest, signal: AbortSignal): Promise<Reply> {
    switch (request.type) {
      case "automations.page":
        return this.#page(request.zone ?? this.#deps.zone(), signal);
      case "automations.history":
        return this.#history(request, request.zone ?? this.#deps.zone(), signal);
      case "automations.duplicate":
        return this.#duplicate(request, signal);
      case "automations.restore": {
        const reply = await this.#put(
          { automation: request.automation, expectedRevision: null },
          signal,
        );
        return reply.ok ? { ok: true, id: request.automation.id } : reply;
      }
      case "automations.write": {
        const parsed = AutomationRequest.safeParse({ ...request.request, requestId: "native" });
        if (!parsed.success || !writes.has(parsed.data.type)) return refused(undefined);
        const { requestId: _requestId, ...body } = parsed.data;
        const reply = await this.#deps.owner.request(body, { signal, ...timeout });
        if (!reply.ok) return refused(reply.error);
        // A run that couldn't start yet says why ("Waiting for the last run to finish").
        return reply.run && reply.run.status !== "running"
          ? { ok: true, note: runSummary(reply.run) }
          : { ok: true };
      }
      case "automations.form.open":
        return formOpen(request, this.#deps);
      case "automations.form.preview":
        return await formPreview(request, this.#deps);
      case "automations.save":
        return formSave(request, this.#deps, (put) => this.#put(put, signal));
    }
  }

  async #page(zone: string, signal: AbortSignal): Promise<Reply> {
    const [reply, running] = await Promise.all([
      this.#deps.owner.request(
        { type: "automation.list", includeThreads: true },
        { signal, ...timeout },
      ),
      this.#running(signal),
    ]);
    if (!reply.ok)
      return { ...refused(reply.error), unavailable: reply.error === "automation_unavailable" };
    const lists = automationLists(reply);
    const now = this.#deps.now();
    return {
      ok: true,
      person: lists.person.map((entry) =>
        automationRow(entry, now, zone, this.#deps.threadState, running),
      ),
      threads: lists.threads.map((entry) =>
        automationRow(entry, now, zone, this.#deps.threadState, running),
      ),
      /** Off on the machine: the list says so above its rows, with where to turn them on. */
      off: running === false ? { text: automationsOffText, fix: automationsOffFix } : null,
      pollMs: historyPollMs(
        [...lists.person, ...lists.threads].flatMap((entry) =>
          entry.lastRun ? [entry.lastRun] : [],
        ),
      ),
    };
  }

  async #history(
    request: z.infer<typeof AutomationsHistoryRequest>,
    zone: string,
    signal: AbortSignal,
  ): Promise<Reply> {
    const reply = await this.#deps.owner.request(
      {
        type: "automation.inbox",
        automationId: request.automationId,
        limit: 20,
        ...(request.before ? { before: request.before } : {}),
        ...(request.source ? { source: request.source } : {}),
      },
      { signal, ...timeout },
    );
    if (!reply.ok || !reply.inbox) return refused(reply.error);
    const now = this.#deps.now();
    const runs = reply.inbox.runs;
    return {
      ok: true,
      runs: runs.map((run) => runRow(run, now, zone, this.#deps.threadState)),
      before: reply.inbox.before,
      pollMs: historyPollMs(runs),
    };
  }

  async #duplicate(
    request: z.infer<typeof AutomationsDuplicateRequest>,
    signal: AbortSignal,
  ): Promise<Reply> {
    const copy = duplicateAutomation(request.automation, request.id);
    const reply = await this.#put({ automation: copy, expectedRevision: null }, signal);
    return reply.ok ? { ok: true, id: copy.id } : reply;
  }

  async #put(
    put: { automation: Automation; expectedRevision?: number | null | undefined },
    signal: AbortSignal,
  ): Promise<Reply> {
    const reply = await this.#deps.owner.request(
      {
        type: "automation.put",
        automation: put.automation,
        ...(put.expectedRevision === undefined ? {} : { expectedRevision: put.expectedRevision }),
      },
      { signal, ...timeout },
    );
    if (reply.ok) return { ok: true };
    // A create whose reply was lost, sent again under the same id: the first one landed.
    if (reply.error === "Automation already exists" && put.expectedRevision === null) {
      const listed = await this.#deps.owner
        .request({ type: "automation.list" }, { signal, ...timeout })
        .catch(() => undefined);
      if (listed?.ok && savedBefore(listed.automations ?? [], put.automation)) return { ok: true };
    }
    return refused(reply.error);
  }

  /** Whether the machine runs automations (`automations.enabled`); undefined when unread. */
  async #running(signal: AbortSignal): Promise<boolean | undefined> {
    const reply = await this.#deps.owner
      .request(
        { type: "settings.get", key: "automations.enabled", scope: {} },
        { signal, ...timeout },
      )
      .catch(() => undefined);
    const value = Setting.safeParse(reply).data?.entries?.[0]?.value;
    return typeof value === "boolean" ? value : undefined;
  }
}

const Setting = z.object({ entries: z.array(z.object({ value: z.unknown() })).optional() });
