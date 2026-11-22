import type { Fact, Key } from "@ace/core";
import type { Frame, Translator } from "@ace/engine-api";
import { ContentPart, type ThreadId } from "@ace/protocol";
import { z } from "zod";
import { boundedJson } from "@ace/provider-kit/ipc";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Envelope, object, string, nativeIdentity, type CursorEnvelope } from "./contracts.ts";
import { Children } from "./children.ts";
import { Transcript } from "./transcript.ts";
import { ToolEvents } from "./tool-events.ts";
import { translateDelta } from "./delta-events.ts";
import { cursorFailure } from "./failure-kind.ts";
import { storedUpdate, storeGap } from "./recovered-tail.ts";

const InputParts = z.array(ContentPart).max(64);

export interface CursorTranslatorOptions {
  threadId: ThreadId;
  rootKey: Key;
  maxIdentities?: number;
  maxRetainedBytes?: number;
}
/** Synchronous pure fold. SDK generation/segment/order provenance is independent of message text. */
export class CursorTranslator implements Translator {
  private diagnostics: import("@ace/protocol").RawPayload[] = [];
  private root: Key;
  private rootSeen = false;
  private generation: string | undefined;
  private operation: string | undefined;
  private segment = 0;
  private sequence = -1;
  private active = false;
  private replacement = false;
  private interrupted = false;
  private cwd = "";
  private transcript: Transcript;
  private tools: ToolEvents;
  private children: Children;
  private max: number;
  private retainedLimit: number;
  private usagePosition = 0;
  private overflow = false;
  private current: CursorEnvelope | undefined;
  private noticeIndex = 0;
  private noticeSequence = -1;
  /** The attempted send whose admission (its `segment`) starts the turn. */
  private attempt: CursorEnvelope | undefined;
  /** The admitted turn's own namespace: a recovered tail continues its items, not new ones. */
  private turnNamespace = "";
  /** Whether the open turn showed any answer text, live or recovered. */
  private sawText = false;
  /** Whether anything of the open turn came back from Cursor's store, and what never can. */
  private recoveredAny = false;
  private gaps = new Set<string>();
  private now = 0;
  constructor(options: CursorTranslatorOptions) {
    this.root = options.rootKey;
    this.max = options.maxIdentities ?? 2048;
    this.retainedLimit = options.maxRetainedBytes ?? 2_097_152;
    if (
      !Number.isSafeInteger(this.max) ||
      this.max < 1 ||
      this.max > 8192 ||
      !Number.isSafeInteger(this.retainedLimit) ||
      this.retainedLimit < 4096 ||
      this.retainedLimit > 8_388_608
    )
      throw new Error("Invalid SDK translator budget");
    this.children = new Children(this.max);
    this.tools = new ToolEvents({
      children: this.children,
      limit: this.max,
      retainedLimit: this.retainedLimit,
    });
    this.transcript = new Transcript("unopened", this.max);
  }
  takeDiagnostics(): import("@ace/protocol").RawPayload[] {
    const diagnostics = this.diagnostics;
    this.diagnostics = [];
    return diagnostics;
  }
  tick(_now: number): Fact[] {
    return [];
  }
  translate(frame: Frame, now: number): Fact[] {
    this.now = now;
    this.diagnostics = [];
    this.noticeIndex = 0;
    this.noticeSequence = frame.seq;
    this.current = undefined;
    if (frame.channel !== "sdk" || this.overflow) return [];
    try {
      // Synthetic/replay callers get the same admission guard as live encoded ingress.
      const payload =
        frame.payload && ProviderPayload.is(frame.payload) && frame.payload.data === frame.data
          ? frame.payload
          : new ProviderPayload(boundedJson(frame.data));
      this.diagnostics = [{ type: "cursor.sdk.v1", data: payload.data }];
      const parsed = Envelope.safeParse(payload.data);
      if (!parsed.success)
        return [this.notice("Malformed SDK boundary envelope", frame.data, "error")];
      const event = parsed.data;
      if (this.generation && this.generation !== event.generation) {
        if (event.kind !== "open") return [];
        this.sequence = -1;
        this.generation = event.generation;
      }
      if (frame.seq <= this.sequence) return [];
      this.sequence = frame.seq;
      this.generation ??= event.generation;
      this.current = event;
      const body = object(event.body);
      const namespace = `${event.generation}:${event.operationId}:${event.segment}`;
      // Output for the attempted send is admission too: the host holds it until `segment`, but
      // frames an earlier build stored, and recordings of it, interleave the two.
      const attempt = this.attempt;
      const admitted =
        attempt &&
        attempt.operationId === event.operationId &&
        attempt.segment === event.segment &&
        ["delta", "delta-chunk", "message", "shell-output", "blob", "result"].includes(event.kind)
          ? this.admit(attempt)
          : [];
      const facts = this.step(frame, event, body, namespace);
      return admitted.length ? [...admitted, ...facts] : facts;
    } catch {
      if (this.overflow) return [];
      this.overflow = true;
      return [
        ...this.children.preserve(),
        this.notice(
          "SDK payload or identity budget exceeded. Host must be stopped; checkpoint retained and surviving work remains uncertain.",
          { overflow: true },
          "error",
        ),
        { type: "process.exited", deliberate: false, message: "SDK translation budget exceeded" },
      ];
    }
  }
  private step(
    frame: Frame,
    event: CursorEnvelope,
    body: Record<string, unknown>,
    namespace: string,
  ): Fact[] {
    if (event.kind === "open") {
      this.rootSeen = true;
      this.cwd = string(body.cwd) ?? "";
      const model = string(body.model);
      return [
        {
          type: "agent.seen",
          agent: this.root,
          origin: "root",
          fidelity: "full",
          cwd: this.cwd,
          ...(model ? { model } : {}),
          native: { provider: "cursor", ...(event.agentId ? { nativeId: event.agentId } : {}) },
        },
      ];
    }
    // The attempt is stored before Cursor sees the input; nothing shows until Cursor admits it
    // (ADR 0043, amendment of 2026-11-22), so a send that never reached Cursor starts nothing.
    if (event.kind === "send") {
      this.attempt = event;
      // Working while Cursor takes the input (seconds, for a cold model), without a run that
      // would take the input before Cursor has it.
      return this.active
        ? []
        : [{ type: "wake.expected", agent: this.root, until: this.now + 600_000 }];
    }
    if (event.kind === "segment") {
      const attempt = this.attempt;
      if (
        !attempt ||
        attempt.operationId !== event.operationId ||
        attempt.segment !== event.segment
      )
        return [];
      return this.admit(attempt);
    }
    if (event.kind === "admission") {
      const attempt = this.attempt;
      if (
        !attempt ||
        attempt.operationId !== string(body.operationId) ||
        attempt.segment !== body.segment
      )
        return [];
      if (body.admitted === true) return this.admit(attempt);
      this.attempt = undefined;
      return [
        { type: "wake.expected", agent: this.root, until: this.now },
        this.notice(
          "ace restarted before Cursor received this message. It was not sent; it is still in the queue.",
          event,
          "warning",
        ),
      ];
    }
    if (event.kind === "recovered") {
      if (!this.active || !event.runId) return [];
      this.recoveredAny = true;
      const gap = storeGap(event.body);
      if (gap && this.gaps.size < 4) this.gaps.add(gap);
      const update = storedUpdate(event.body);
      return update ? this.delta(update, this.root, this.turnNamespace, 0) : [];
    }
    if (event.kind === "recovery") return this.recover(event, body);
    if (event.kind === "snapshot")
      return [
        this.notice(
          "Checkpoint snapshot retained for reconciliation; positional UUIDs do not establish live-message identity. No uncertain history was appended.",
          event,
          "warning",
        ),
      ];
    // A shared host/store failure fences execution even when an old segment caused it.
    if (
      event.kind === "error" &&
      ["boundary_overflow", "checkpoint_budget"].includes(string(body.code) ?? "")
    )
      return [
        ...this.tools.preserve(),
        ...this.children.preserve(),
        this.notice(
          string(body.message) ?? "SDK host resource budget failed; checkpoint retained",
          event,
          "error",
        ),
        {
          type: "process.exited",
          deliberate: false,
          // The fence's own words name the cause, such as ace's storage failing.
          message: string(body.message)?.slice(0, 512) ?? "Cursor's turn was fenced",
        },
      ];
    if (event.kind === "blob") return [{ type: "signal", agent: this.root }];
    if (event.kind === "shell-output") {
      const parent = nativeIdentity(body.parentCallId);
      const child = parent ? this.children.calls.get(`${namespace}:call:${parent}`) : undefined;
      if (parent && !child)
        return [this.notice("Shell output has no observed owning child", event, "warning")];
      return this.tools.output(
        body,
        child?.key ?? this.root,
        namespace,
        event,
        this.transcript,
        this.operation,
        this.segment,
        this.cwd,
        (text, data, level) => this.notice(text, data, level),
      );
    }
    const stale = event.operationId !== this.operation || event.segment !== this.segment;
    if (event.kind === "host-exit") {
      const unsettled =
        [...this.children.calls.values()].some((child) => !child.settled) ||
        [...this.tools.calls.values()].some((tool) => !tool.terminal);
      const preserved = this.children.preserve();
      if (!this.active && !unsettled) return preserved;
      return [
        ...preserved,
        this.notice(
          "Cursor stopped unexpectedly. Unfinished work needs your attention.",
          event,
          "warning",
          "cursor.work-stopped",
        ),
      ];
    }
    // A failure of the attempted send is the person's to see though no turn started.
    const attemptFailed = event.kind === "error" && this.attempt?.operationId === event.operationId;
    if (
      stale &&
      !attemptFailed &&
      !(event.kind === "error" && event.operationId === "open" && !this.rootSeen)
    ) {
      // Surviving child facts belong to their original call namespace, never the replacement root.
      if (event.kind === "delta" && body.type === "tool-call-completed") {
        const call = `${namespace}:call:${nativeIdentity(body.callId) ?? ""}`;
        if (this.tools.calls.has(call) || this.children.calls.has(call)) {
          return this.delta(body, this.tools.calls.get(call)?.agent ?? this.root, namespace, 0);
        }
      }
      if (["delta", "delta-chunk"].includes(event.kind) && body.type === "tool-call-delta") {
        const call = `${namespace}:call:${nativeIdentity(body.callId) ?? ""}`;
        const child = this.children.calls.get(call);
        if (child && !child.settled)
          return this.delta(object(body.taskUpdate), child.key, namespace, 1);
      }
      return [];
    }
    switch (event.kind) {
      case "segment":
        return [];
      case "delta-chunk":
      case "delta":
        return this.delta(body, this.root, namespace, 0);
      case "message":
        // Frames from an earlier build: the stream's copy of onDelta, never shown twice.
        return [{ type: "signal", agent: this.root }];
      case "cancel": {
        if (frame.dir === "send") {
          this.replacement = body.replacement === true;
          this.interrupted = !this.replacement;
        }
        return [];
      }
      case "result": {
        if (!this.active) return [];
        if (!["finished", "cancelled", "error"].includes(string(body.status) ?? ""))
          return [
            ...this.tools.preserve(),
            ...this.children.preserve(),
            this.notice(
              "Unrecognized SDK terminal status; execution remains uncertain",
              event,
              "warning",
            ),
          ];
        const facts = [
          ...this.transcript.end(),
          ...this.tools.preserve(),
          ...this.children.preserve(),
        ];
        if (body.status === "error")
          facts.push(
            this.notice(
              string(object(body.error).message) ?? "Cursor SDK run failed",
              event,
              "error",
              "cursor.run-failed",
            ),
          );
        if (this.replacement) return facts;
        this.active = false;
        const outcome =
          body.status === "finished"
            ? "completed"
            : body.status === "cancelled" || this.interrupted
              ? "interrupted"
              : "failed";
        facts.push({
          type: "turn.ended",
          agent: this.root,
          nativeTurnId: `sdk:${event.operationId}`,
          outcome,
          ...(outcome === "failed"
            ? {
                error: failedRun(
                  object(body.error).code,
                  string(object(body.error).message) ?? "Cursor SDK run failed",
                  object(body.error).retryable,
                ),
              }
            : {}),
        });
        return facts;
      }
      case "error": {
        const facts: Fact[] = [];
        // A send Cursor refused or failed to take: nothing is starting any more.
        if (this.attempt?.operationId === event.operationId) {
          this.attempt = undefined;
          facts.push({ type: "wake.expected", agent: this.root, until: this.now });
        }
        if (!this.rootSeen) {
          this.rootSeen = true;
          facts.push({
            type: "agent.seen",
            agent: this.root,
            origin: "root",
            fidelity: "full",
            native: { provider: "cursor" },
            cwd: this.cwd,
          });
        }
        const text = string(body.message) ?? "SDK failure; delivery or execution is uncertain";
        const failure = cursorFailure(body.code, text, body.retryable);
        facts.push(
          ...this.tools.preserve(),
          ...this.children.preserve(),
          this.notice(
            text,
            event,
            "error",
            failure.code ?? (failure.kind === "quota" ? "quota" : "cursor.run-failed"),
          ),
        );
        if (this.active && !this.replacement && body.settled === true) {
          this.active = false;
          facts.push({
            type: "turn.ended",
            agent: this.root,
            nativeTurnId: `sdk:${event.operationId}`,
            outcome: "failed",
            error: failedRun(body.code, string(body.message) ?? "SDK run failed", body.retryable),
          });
        }
        return facts;
      }
      case "close":
        return this.children.preserve();
      default:
        return [];
    }
  }
  /** Cursor admitted the attempted send: the turn starts and its input shows. */
  private admit(event: CursorEnvelope): Fact[] {
    this.attempt = undefined;
    const body = object(event.body);
    const namespace = `${event.generation}:${event.operationId}:${event.segment}`;
    const facts: Fact[] = [];
    if (this.operation !== event.operationId || !this.active) {
      this.tools.trim();
      this.children.trim();
      this.usagePosition = 0;
      this.operation = event.operationId;
      this.active = true;
      facts.push({
        type: "turn.started",
        agent: this.root,
        nativeTurnId: `sdk:${event.operationId}`,
        trigger: "user",
      });
    }
    facts.push(...this.transcript.end());
    const input = InputParts.safeParse(body.input);
    if (input.success && input.data.length)
      facts.push({
        type: "item.upsert",
        agent: this.root,
        item: `${namespace}:user:${event.commandId ?? event.segment}`,
        draft: {
          type: "message",
          role: "user",
          parts: input.data,
          complete: true,
          ...(event.commandId && event.commandId.length <= 256
            ? { nativeId: event.commandId }
            : {}),
        },
      });
    this.segment = event.segment;
    this.replacement = false;
    this.interrupted = false;
    this.transcript = new Transcript(namespace, this.max);
    this.turnNamespace = namespace;
    this.sawText = false;
    this.recoveredAny = false;
    this.gaps.clear();
    return facts;
  }
  /**
   * A run's outcome read back from the SDK store after a restart. It ends the open turn as
   * the run ended, so a run that finished just before the crash shows finished with its answer;
   * a run that was still working was stopped first, never shown done.
   */
  private recover(event: CursorEnvelope, body: Record<string, unknown>): Fact[] {
    const status = string(body.nativeStatus) ?? "unknown";
    const result = string(body.result);
    // The stored result stands in for an answer only when none was shown, live or recovered.
    const answer =
      status === "finished" && result && !this.sawText && this.active
        ? this.delta({ type: "text-delta", text: result }, this.root, this.turnNamespace, 0)
        : [];
    const what =
      status === "finished"
        ? "Cursor finished this run while ace was restarting."
        : status === "running" || status === "queued"
          ? "ace restarted while this Cursor run was working, so it was stopped. Nothing was sent again."
          : `Cursor's run ended (${status}) while ace was restarting.`;
    const source =
      this.recoveredAny || answer.length
        ? " What it did after the live stream was cut off is recovered from Cursor's saved session."
        : "";
    const facts: Fact[] = [
      ...answer,
      ...this.transcript.end(),
      ...this.tools.preserve(),
      ...this.children.preserve(),
      this.notice(
        `${what}${source}`,
        event,
        body.interrupted ? "warning" : "info",
        "cursor.recovered",
      ),
      ...[...this.gaps].map((gap) => this.notice(gap, event, "info", "cursor.recovered")),
      ...(body.tailOmitted === true
        ? [
            this.notice(
              "This turn began before ace was updated, so what Cursor did after the restart can't be lined up with what is shown here; it isn't repeated.",
              event,
              "info",
              "cursor.recovered",
            ),
          ]
        : []),
    ];
    this.gaps.clear();
    if (!this.active || !this.operation) return facts;
    this.active = false;
    // A run a restart cut off is not done: it stopped part-way and needs the person's look.
    const outcome =
      status === "finished" ? "completed" : status === "cancelled" ? "interrupted" : "failed";
    facts.push({
      type: "turn.ended",
      agent: this.root,
      nativeTurnId: `sdk:${this.operation}`,
      outcome,
      ...(outcome === "failed"
        ? {
            error: failedRun(
              undefined,
              string(body.error) ??
                (body.interrupted
                  ? "ace restarted while Cursor was working, so the run was stopped"
                  : "Cursor SDK run failed"),
            ),
          }
        : {}),
    });
    return facts;
  }
  private notice(
    text: string,
    data: unknown,
    level: "info" | "warning" | "error" = "info",
    code = "cursor.diagnostic",
  ): Fact {
    return {
      type: "item.upsert",
      agent: this.root,
      item: `sdk:notice:${this.generation ?? "invalid"}:${this.noticeSequence}:${this.noticeIndex++}`,
      draft: {
        type: "notice",
        diagnostic: true,
        code,
        text,
        level,
        complete: true,
        raw: [
          this.current?.raw ?? { type: "cursor.sdk.v1", data },
          ...(/^(?:Malformed SDK boundary|Checkpoint snapshot retained|Shell output has no observed|SDK (?:task summary|checkpoint recovery))/.test(
            text,
          )
            ? [{ type: "native-notice", data: {} }]
            : []),
        ],
      },
    };
  }
  private delta(
    body: Record<string, unknown>,
    agent: Key,
    namespace: string,
    depth: number,
  ): Fact[] {
    if (depth === 0 && agent === this.root && body.type === "text-delta") this.sawText = true;
    return translateDelta(
      body,
      agent,
      namespace,
      {
        children: this.children,
        tools: this.tools,
        transcript: this.transcript,
        current: this.current,
        operation: this.operation,
        segment: this.segment,
        cwd: this.cwd,
        nextUsage: () => ++this.usagePosition,
        notice: (text, data, level) => this.notice(text, data, level),
      },
      depth,
    );
  }
}

function failedRun(code: unknown, message: string, retryable?: unknown) {
  return { ...cursorFailure(code, message, retryable), message };
}
