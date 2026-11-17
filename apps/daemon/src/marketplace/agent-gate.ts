import type { MarketOperation } from "@ace/protocol/marketplace";

/*
 * Which market requests an agent may make itself (ADR 0176 §12.5, owner decision 1). An
 * allowlist: reads, local checks, the draft-and-publish flow, its status and versions. Every
 * other operation, including any added later, is the person's: ace opens a request in the
 * asking thread's strip, which only a person answers. With "Ask me before agents publish" on,
 * publishing a draft is the person's too. Pure.
 */

/** Operations an agent may run under its provider's permissions. */
const agentOperations: ReadonlySet<MarketOperation["op"]> = new Set<MarketOperation["op"]>([
  "sources",
  "search",
  "home",
  "read",
  "prepare",
  "prepareUpdate",
  "readReview",
  "cancel",
  "installed",
  "refresh",
  "spadeSkills",
  "spadeSkillFiles",
  "discover",
  "publisher",
  "picture",
  "publishables",
  "botRecipe",
  "privacyCheck",
]);

type PublishRequest = Extract<MarketOperation, { op: "publish" }>["request"];

/** Publishing actions an agent may take: its drafts, publishing one, its status and versions. */
const agentPublishActions: ReadonlySet<PublishRequest["action"]> = new Set<
  PublishRequest["action"]
>([
  "me",
  "entry",
  "signals",
  "verification",
  "draftCreate",
  "draftCheck",
  "draftRead",
  "draftUpdate",
  "draftDelete",
  "draftPublish",
]);

/** What the gate knows besides the operation. */
export interface AgentFacts {
  /** The asking agent's product name, as the person knows it: "Codex". */
  readonly agent: string;
  /** Settings: `market.askBeforeAgentPublish`. */
  readonly askBeforePublish: boolean;
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

/** Whether `operation` is on the agents' allowlist, given the person's settings. */
export function agentMayRun(operation: MarketOperation, askBeforePublish: boolean): boolean {
  if (operation.op !== "publish") return agentOperations.has(operation.op);
  const action = operation.request.action;
  if (action === "draftPublish") return !askBeforePublish;
  return agentPublishActions.has(action);
}

function wording(operation: MarketOperation, facts: AgentFacts): Wording {
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
    case "remove":
      return { doing: `remove ${ref(operation)}`, gerund: "Removing it", action: "Remove…" };
    case "addSource":
      return {
        doing: `add the market source ${operation.address}`,
        gerund: "Adding a source",
        action: "Add…",
      };
    case "removeSource":
      return {
        doing: `remove the market source ${operation.id}`,
        gerund: "Removing a source",
        action: "Remove…",
      };
    case "setSource":
      return {
        doing: `turn the market source ${operation.id} ${operation.enabled ? "on" : "off"}`,
        gerund: "Changing a source",
        action: operation.enabled ? "Turn on…" : "Turn off…",
      };
    case "report":
      return { doing: `report ${ref(operation)}`, gerund: "Reporting", action: "Report…" };
    case "publish":
      return publishWording(operation.request, facts);
    default:
      return {
        doing: `change the market (${operation.op})`,
        gerund: "This change",
        action: "Allow…",
      };
  }
}

function publishWording(request: PublishRequest, facts: AgentFacts): Wording {
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
    case "createProfile":
    case "editProfile":
    case "setAvatar":
    case "setPins":
      return {
        doing: "change your publisher profile",
        gerund: "Changing your profile",
        action: "Change…",
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
      return {
        doing: `publish draft ${request.id}`,
        gerund: "Publishing",
        action: "Publish…",
      };
    case "visibility":
      return {
        doing: `make ${ref(request)} ${request.visibility}`,
        gerund: "Changing who sees it",
        action: "Change…",
      };
    case "latest":
      return {
        doing: request.version
          ? `make ${request.version} the latest of ${ref(request)}`
          : `let the market choose the latest of ${ref(request)}`,
        gerund: "Choosing the latest version",
        action: "Change…",
      };
    case "archive":
      return {
        doing: `${request.archived ? "archive" : "unarchive"} ${ref(request)}`,
        gerund: request.archived ? "Archiving" : "Unarchiving",
        action: request.archived ? "Archive…" : "Unarchive…",
      };
    case "listing":
    case "preview":
      return {
        doing: `change the listing of ${ref(request)}`,
        gerund: "Changing a listing",
        action: "Change…",
      };
    case "changelog":
      return {
        doing: `change the changelog of ${ref(request)}`,
        gerund: "Changing a changelog",
        action: "Change…",
      };
    case "deprecate":
      return {
        doing: `deprecate ${ref(request)}`,
        gerund: "Deprecating",
        action: "Deprecate…",
        why: request.note,
      };
    case "appeal":
      return {
        doing: `appeal for ${ref(request)}`,
        gerund: "Appealing",
        action: "Appeal…",
        why: request.note,
      };
    default:
      return {
        doing: `change your market publications (${request.action})`,
        gerund: "This change",
        action: "Allow…",
      };
  }
}

/** Whether an agent's market request runs, or becomes the person's request. */
export function agentRoute(operation: MarketOperation, facts: AgentFacts): AgentRoute {
  if (agentMayRun(operation, facts.askBeforePublish)) return run;
  const words = wording(operation, facts);
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
