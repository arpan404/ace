import type { MarketOperation } from "@ace/protocol/marketplace";

/*
 * Which market requests an agent may make itself (ADR 0176 §12.5, owner decision 1). Publishing
 * follows the provider's permissions; withdrawing, transfers, handle changes, deleting an entry,
 * verified-profile edits, verification and installing are the person's. Asked for one, ace opens
 * a request in the asking thread's strip instead, which only a person's device answers. With
 * "Ask me before agents publish" on, publishing a draft is the person's too. Pure.
 */

/** What the gate knows besides the operation. */
export interface AgentFacts {
  /** The asking agent's product name, as the person knows it: "Codex". */
  readonly agent: string;
  /** Settings: `market.askBeforeAgentPublish`. */
  readonly askBeforePublish: boolean;
  /** For a profile edit: whether the profile carries ace's verified mark; unknown counts as yes. */
  readonly verifiedProfile?: boolean | undefined;
  /** For an install: what it installs, "spade-plugin/linear-sync 0.4.1", from its review. */
  readonly installing?: string | undefined;
}

/** A person-only request, in the person's words. */
export interface PersonAsk {
  /** "Codex asks you to withdraw suit/dusk-harbor 1.2.0: the colours fail contrast." */
  readonly title: string;
  /** The strip's button that runs it: "Withdraw…". */
  readonly action: string;
  /** What the caller reads: "Withdrawing is yours to do. ace asked you in this thread." */
  readonly refusal: string;
}

export type AgentRoute =
  | { readonly kind: "run" }
  | { readonly kind: "person"; readonly ask: PersonAsk };

const run: AgentRoute = { kind: "run" };

interface Wording {
  /** "withdraw suit/dusk-harbor 1.2.0" */
  readonly doing: string;
  /** "Withdrawing" */
  readonly gerund: string;
  readonly action: string;
  readonly why?: string | undefined;
}

const ref = (key: { type: string; name: string; version?: string | undefined }) =>
  `${key.type}/${key.name}${key.version ? ` ${key.version}` : ""}`;

function wording(operation: MarketOperation, facts: AgentFacts): Wording | undefined {
  switch (operation.op) {
    case "install":
      return {
        doing: `install ${facts.installing ?? "an entry from the market"}`,
        gerund: "Installing",
        action: "Install…",
      };
    case "turnOn":
      return {
        doing: `turn ${ref(operation)} back on`,
        gerund: "Turning it back on",
        action: "Turn on…",
      };
    case "publish":
      break;
    default:
      return undefined;
  }
  const request = operation.request;
  switch (request.action) {
    case "withdraw":
      return {
        doing: `withdraw ${ref(request)}`,
        gerund: "Withdrawing",
        action: "Withdraw…",
        why: request.reason,
      };
    case "transfer":
      return {
        doing: `transfer ${ref(request)} to @${request.to}`,
        gerund: "Transferring",
        action: "Transfer…",
      };
    case "transferAnswer":
      return request.accept
        ? {
            doing: `accept transfer ${request.id}`,
            gerund: "Accepting a transfer",
            action: "Accept…",
          }
        : {
            doing: `decline transfer ${request.id}`,
            gerund: "Declining a transfer",
            action: "Decline…",
          };
    case "changeHandle":
      return {
        doing: `change your handle to @${request.handle}`,
        gerund: "Changing your handle",
        action: "Change…",
      };
    case "deleteEntry":
      return { doing: `delete ${ref(request)}`, gerund: "Deleting an entry", action: "Delete…" };
    case "editProfile":
      return facts.verifiedProfile === false
        ? undefined
        : {
            doing: "edit your verified profile",
            gerund: "Editing a verified profile",
            action: "Edit…",
          };
    case "applyVerification":
      return {
        doing: "apply for verification",
        gerund: "Applying for verification",
        action: "Apply…",
      };
    case "checkVerification":
      return {
        doing: "check your verification again",
        gerund: "Checking verification",
        action: "Check…",
      };
    case "draftPublish":
      return facts.askBeforePublish
        ? { doing: `publish draft ${request.id}`, gerund: "Publishing", action: "Publish…" }
        : undefined;
    default:
      return undefined;
  }
}

/** Whether an agent's market request runs, or becomes the person's request. */
export function agentRoute(operation: MarketOperation, facts: AgentFacts): AgentRoute {
  const words = wording(operation, facts);
  if (!words) return run;
  const why = words.why?.trim().replace(/[.\s]+$/, "");
  return {
    kind: "person",
    ask: {
      title: `${facts.agent} asks you to ${words.doing}${why ? `: ${why}` : ""}.`,
      action: words.action,
      refusal: `${words.gerund} is yours to do. ace asked you in this thread.`,
    },
  };
}

/** Whether answering `operation` needs the profile's verified mark first (a profile edit). */
export function needsVerifiedFact(operation: MarketOperation): boolean {
  return operation.op === "publish" && operation.request.action === "editProfile";
}
