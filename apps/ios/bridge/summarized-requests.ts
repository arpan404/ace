import { ClientError, type ChangeTap, type ClientCore, type ThreadSource } from "@ace/client";
import type {
  CommandPayload,
  Interaction,
  InteractionRequest,
  InteractionResolution,
  ThreadId,
} from "@ace/protocol";
import { affirms, answerRefusal, sentSummarized } from "@ace/projection/interaction-summary";
import { interactionSummaryKey, wholeRequestFailure, wholeRequestLoading } from "@ace/ui-core";

/*
 * A request the daemon sends summarized (ADR 0157) carries only its summary with the thread and
 * offers only declines until the phone reads its whole payload on demand (`interaction.read`).
 * Once the exact version on screen has loaded, affirmative answers name that `version` in
 * `readWhole`; if the summary changes meanwhile, the old version is dropped and read again so an
 * answer never goes for a version the person didn't see.
 */

const verbs: Partial<Record<Interaction["request"]["kind"], string>> = {
  approval: "approve",
  plan_review: "approve",
  question: "answer",
  elicitation: "answer",
};

export type WholeRequestState =
  | { readonly status: "whole"; readonly request: InteractionRequest }
  | { readonly status: "loading" }
  | {
      readonly status: "loaded";
      readonly request: InteractionRequest;
      readonly version: string;
    }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly text: string;
      readonly retryable: boolean;
    };

/** `interaction` carrying the full request once `whole` has loaded, with `truncated` cleared. */
export function withWholeRequest(
  interaction: Interaction,
  whole: WholeRequestState | undefined,
): Interaction {
  if (whole?.status !== "loaded" && whole?.status !== "whole") return interaction;
  const { truncated: _, ...rest } = interaction;
  return { ...rest, request: whole.request };
}

/**
 * What a summarized request's card says until it has loaded in full: to open it (nothing read
 * yet), that it is loading, or why it couldn't. "" once it came whole or has loaded.
 */
export function summarizedNote(interaction: Interaction, whole?: WholeRequestState): string {
  const verb = verbs[interaction.request.kind];
  if (!verb || !sentSummarized(interaction)) return "";
  if (whole?.status === "loaded" || whole?.status === "whole") return "";
  if (whole?.status === "failed") return whole.text;
  if (whole?.status === "loading") return wholeRequestLoading;
  return `This request is too large to show with the thread. Review it to read it in full before you ${verb} it.`;
}

/** A summarized `interaction` with only the approval options that decline. */
export function declinesOnly(interaction: Interaction): Interaction {
  const request = interaction.request;
  if (request.kind !== "approval") return interaction;
  return {
    ...interaction,
    request: {
      ...request,
      options: request.options.filter((option) => !option.kind.startsWith("allow")),
    },
  };
}

/** `resolution`, unless it says yes to a request the phone hasn't read whole. */
export function phoneAnswer<R extends InteractionResolution>(
  interaction: Interaction,
  resolution: R | undefined,
  readWhole = false,
): R | undefined {
  if (!resolution) return undefined;
  return answerRefusal(interaction, resolution, readWhole) ? undefined : resolution;
}

/** The canonical resolution for an approval option, gated on `readWhole` when affirmative. */
export function approvalResolution(
  interaction: Interaction | undefined,
  optionId: string,
  readWhole = false,
): Extract<CommandPayload, { type: "interaction.resolve" }>["resolution"] | undefined {
  if (interaction?.state !== "pending" || interaction.request.kind !== "approval") return undefined;
  const option = interaction.request.options.find((candidate) => candidate.id === optionId);
  return option
    ? phoneAnswer(interaction, { kind: "approval", optionId: option.id }, readWhole)
    : undefined;
}

type Reader = Pick<ClientCore, "readInteraction">;

interface Entry {
  summaryKey: string;
  abort: AbortController;
  state: WholeRequestState;
}

function failureCode(error: unknown): string {
  if (!(error instanceof ClientError)) return "unknown";
  return error.code === "daemon" ? error.message : error.code;
}

/**
 * On-demand whole-request reads for one open thread session. Tracks each read against the
 * interaction summary's key (`interactionSummaryKey`), re-reads automatically if the summary
 * changes while open, and supplies the loaded `version` (`readWhole`) when building an
 * affirmative resolution.
 */
export class WholeRequests {
  readonly #client: Reader;
  readonly #store: ThreadSource;
  readonly #threadId: ThreadId;
  readonly #signal: AbortSignal;
  readonly #emit: (interactionId: string) => void;
  readonly #entries = new Map<string, Entry>();

  constructor(
    client: Reader,
    store: ThreadSource,
    threadId: ThreadId,
    signal: AbortSignal,
    emit: (interactionId: string) => void,
  ) {
    this.#client = client;
    this.#store = store;
    this.#threadId = threadId;
    this.#signal = signal;
    this.#emit = emit;
  }

  /** Current whole-request state for `interaction`, or undefined if not yet requested. */
  state(interaction: Interaction): WholeRequestState | undefined {
    if (!sentSummarized(interaction)) {
      return { status: "whole", request: interaction.request };
    }
    const entry = this.#entries.get(interaction.id);
    if (!entry) return undefined;
    if (entry.summaryKey !== interactionSummaryKey(interaction)) {
      return { status: "loading" };
    }
    return entry.state;
  }

  /** Fetch the full request for `interactionId` when it is pending and summarized. */
  read(interactionId: string, retry = false): void {
    if (this.#signal.aborted) return;
    const interaction = this.#store.interaction(interactionId);
    if (!interaction || interaction.state !== "pending" || !sentSummarized(interaction)) return;
    const summaryKey = interactionSummaryKey(interaction);
    const existing = this.#entries.get(interactionId);
    if (
      !retry &&
      existing?.summaryKey === summaryKey &&
      (existing.state.status === "loading" || existing.state.status === "loaded")
    ) {
      return;
    }
    existing?.abort.abort();
    const abort = new AbortController();
    const onParentAbort = () => abort.abort();
    this.#signal.addEventListener("abort", onParentAbort, { once: true });
    const entry: Entry = {
      summaryKey,
      abort,
      state: { status: "loading" },
    };
    this.#entries.set(interactionId, entry);
    this.#emit(interactionId);
    this.#client
      .readInteraction({ threadId: this.#threadId, interactionId }, { signal: abort.signal })
      .then(
        ({ request, version }) => {
          this.#signal.removeEventListener("abort", onParentAbort);
          if (abort.signal.aborted || this.#entries.get(interactionId) !== entry) return;
          const current = this.#store.interaction(interactionId);
          if (!current || current.state !== "pending" || !sentSummarized(current)) {
            this.#entries.delete(interactionId);
            return;
          }
          if (interactionSummaryKey(current) !== summaryKey) {
            this.read(interactionId, true);
            return;
          }
          entry.state = { status: "loaded", request, version };
          this.#emit(interactionId);
        },
        (error: unknown) => {
          this.#signal.removeEventListener("abort", onParentAbort);
          if (abort.signal.aborted || this.#entries.get(interactionId) !== entry) return;
          const code = failureCode(error);
          const { text, retryable } = wholeRequestFailure(code);
          entry.state = { status: "failed", code, text, retryable };
          this.#emit(interactionId);
        },
      );
  }

  /** Reconcile tracked reads when the thread store's interactions change. */
  readonly changed: ChangeTap = (keys) => {
    if (!this.#entries.size) return;
    for (const [id, entry] of this.#entries) {
      if (keys !== "all" && !keys.has("interactions") && !keys.has(`interaction:${id}`)) {
        continue;
      }
      const current = this.#store.interaction(id);
      if (!current || current.state !== "pending" || !sentSummarized(current)) {
        entry.abort.abort();
        this.#entries.delete(id);
        continue;
      }
      if (entry.summaryKey !== interactionSummaryKey(current)) {
        this.read(id, true);
        continue;
      }
      this.#emit(id);
    }
  };

  /**
   * Build a resolution against the interaction's current state, pairing affirmative answers to a
   * summarized request with the exact loaded `version` (`readWhole`). `seen` is the version the
   * card showed when the person tapped: any answer naming another one is refused (the request
   * changed under the tap), and a yes needs `seen` to be the version loaded now.
   */
  resolution(
    interactionId: string,
    build: (interaction: Interaction, readWhole: boolean) => InteractionResolution | undefined,
    seen?: string,
  ):
    | {
        resolution: InteractionResolution;
        readWhole?: string;
        summarized: boolean;
      }
    | undefined {
    const summary = this.#store.interaction(interactionId);
    if (!summary || summary.state !== "pending") return undefined;
    const summarized = sentSummarized(summary);
    const whole = this.state(summary);
    const loaded = whole?.status === "loaded" ? whole : undefined;
    if (summarized && seen !== undefined && seen !== loaded?.version) return undefined;
    const interaction = loaded ? withWholeRequest(summary, loaded) : summary;
    const resolution = build(interaction, loaded !== undefined);
    if (!resolution) return undefined;
    if (summarized && affirms(interaction.request, resolution)) {
      if (!loaded || seen !== loaded.version) return undefined;
      return { resolution, readWhole: loaded.version, summarized: true };
    }
    return { resolution, summarized };
  }

  dispose(): void {
    for (const entry of this.#entries.values()) entry.abort.abort();
    this.#entries.clear();
  }
}
