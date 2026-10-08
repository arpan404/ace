import type { ApprovalOption, InteractionRequest, PermissionReview } from "@ace/protocol";
import { alwaysAsks, appName } from "./app-names.ts";
import { offeredOptions, reviewReason } from "./approvals.ts";
import { addressHost } from "./browser-address.ts";
import { displayCommand, unwrapShellCommand } from "./step-display.ts";

/*
 * How an approval reads on a card, in the thread, in Activity and for computer use alike: a
 * title, the one thing it acts on (a command, a script, files, an app), one plain reason, and
 * the same three verbs everywhere: Allow once, Always allow (where the request offers a standing
 * grant) and Deny. Everything else (the facts, the medium risk, any other option the request
 * offers) sits behind the card's Details.
 */

type ApprovalRequest = Extract<InteractionRequest, { kind: "approval" }>;

export interface ApprovalFact {
  label: string;
  value: string;
  /** Show in monospace: bundle ids, paths, addresses. */
  code: boolean;
}

/** The three answers every approval card offers, in this order. */
export type ApprovalVerb = "allow_once" | "always_allow" | "deny";

const verbLabels: Record<ApprovalVerb, string> = {
  allow_once: "Allow once",
  always_allow: "Always allow",
  deny: "Deny",
};

export interface ApprovalDecision {
  verb: ApprovalVerb;
  option: ApprovalOption;
  /** "Allow once", "Always allow" or "Deny". */
  label: string;
  /**
   * What a standing grant covers, in the tool's or the provider's own words, when the verb alone
   * doesn't say ("Always allow git push in this thread").
   */
  scope: string | undefined;
  /**
   * `primary` is the one filled button, `secondary` a yes that isn't, `quiet` the rest. A request
   * that defaults to no has no primary: nothing invites a reflex approval.
   */
  emphasis: "primary" | "secondary" | "quiet";
}

/** An option outside the three verbs (a thread-wide grant beside an always one, Cancel). */
export interface ApprovalChoice {
  option: ApprovalOption;
  label: string;
}

export interface ApprovalCopy {
  /** A known ace tool (`screen_request_app`, `browser.evaluate`, ...) or undefined. */
  tool: string | undefined;
  /** The request's own title, naming what it acts on: a list row's words and the card's name. */
  title: string;
  /** The card's heading, which leaves the command to its block: "Run this command?". */
  heading: string;
  /** The shell command it would run, as the person would have typed it. */
  command: string | undefined;
  /** The app an app request is about, by name: drawn as its mark beside the title. */
  app: string | undefined;
  /**
   * The one plain reason: what the agent said it needs this for, else the request's own
   * description, else why ace's review sent it on.
   */
  reason: string | undefined;
  /** What approving lets happen, honestly and briefly. `high` reads in the failure tone. */
  risk: { level: "high" | "medium"; text: string } | undefined;
  facts: ApprovalFact[];
  /** Code the person is asked to run, shown verbatim (a page script). */
  code: string | undefined;
  /** Every file an approval would hand over (an upload), in full: none is summarised away. */
  files: readonly string[];
  /** Allow once, Always allow and Deny, each where the request offers it. */
  decisions: ApprovalDecision[];
  /** The request's other options, offered under Details. */
  others: ApprovalChoice[];
  /** The request asks for an explicit yes: no option is primary. */
  defaultToNo: boolean;
}

const refusal = (option: ApprovalOption) =>
  option.kind === "deny" || option.kind === "deny_always" || option.kind === "cancel";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const texts = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

interface ToolCopy {
  title: string;
  app?: string | undefined;
  reason?: string | undefined;
  risk?: ApprovalCopy["risk"];
  facts?: ApprovalFact[];
  code?: string | undefined;
  files?: readonly string[];
  /** What an option grants, where the tool says it better than the provider's label. */
  labels?: Partial<Record<string, string>>;
}

function screenApp(input: Record<string, unknown>, description: string | undefined): ToolCopy {
  const bundleId = text(input["bundleId"]) ?? "";
  const name = appName(bundleId);
  const sensitive = alwaysAsks(bundleId);
  return {
    title: `Let an agent use ${name}`,
    app: name,
    reason: description,
    risk: sensitive
      ? {
          level: "high",
          text: `${name} can hold passwords or run commands. ace asks again every turn, even if you allow it always.`,
        }
      : {
          level: "medium",
          text: `The agent can see ${name}'s windows and click and type in them, in the background while you keep working.`,
        },
    facts: [{ label: "Bundle ID", value: bundleId, code: true }],
    labels: {
      allow_thread: "Allow for this thread",
      allow_always: sensitive ? "Always allow, still asking each turn" : undefined,
    },
  };
}

function screenForeground(
  input: Record<string, unknown>,
  description: string | undefined,
): ToolCopy {
  const bundleId = text(input["bundleId"]) ?? "";
  const name = appName(bundleId);
  return {
    title: `Let the agent bring ${name} to the front`,
    app: name,
    reason: description,
    risk: {
      level: "high",
      text: `It will use your real cursor and keyboard in ${name}. Avoid typing until it hands back; you can take over at any time.`,
    },
    facts: [{ label: "Bundle ID", value: bundleId, code: true }],
  };
}

function browserEvaluate(input: Record<string, unknown>): ToolCopy {
  const origin = text(input["origin"]);
  const url = text(input["url"]);
  const site = addressHost(origin ?? url ?? "") ?? origin ?? "this page";
  const readOnly = input["mode"] === "read-only";
  return {
    title: `Run a script on ${site}`,
    risk: readOnly
      ? {
          level: "medium",
          text: "Read-only: it can read the page, including anything you're signed in to, but can't change it.",
        }
      : {
          level: "high",
          text: "It can read and change the page and act on the site as you.",
        },
    facts: [
      ...(url ? [{ label: "Page", value: url, code: true }] : []),
      { label: "Access", value: readOnly ? "Read only" : "Read and change", code: false },
    ],
    code: text(input["expression"]),
    labels: { allow_site: `Allow read-only scripts on ${site}` },
  };
}

function browserDownload(input: Record<string, unknown>): ToolCopy {
  const origin = text(input["origin"]);
  const site = addressHost(origin ?? "") ?? origin ?? "this page";
  return {
    title: `Download a file from ${site}`,
    risk: {
      level: "medium",
      text: "The file is kept aside in this thread and never opens on its own.",
    },
    facts: origin ? [{ label: "Site", value: origin, code: true }] : [],
  };
}

function browserUpload(input: Record<string, unknown>): ToolCopy {
  const paths = texts(input["paths"]);
  return {
    title:
      paths.length === 1
        ? "Upload a file from outside the project"
        : "Upload files from outside the project",
    risk: {
      level: "high",
      text: "The page receives these files' contents. They are outside this thread's checkout and artifacts.",
    },
    facts: [{ label: "Files", value: String(paths.length), code: false }],
    // Every path the daemon would upload, never a sample: approving covers all of them.
    files: paths,
  };
}

function toolCopy(request: ApprovalRequest): ToolCopy | undefined {
  const target = request.target;
  if (target?.origin !== "ace" && !target?.tool.startsWith("screen_")) return undefined;
  const input = record(target?.input);
  switch (target?.tool) {
    case "screen_request_app":
      return screenApp(input, request.description);
    case "screen_request_foreground":
      return screenForeground(input, request.description);
    case "browser.evaluate":
      return browserEvaluate(input);
    case "browser.downloads":
      return browserDownload(input);
    case "browser.upload":
      return browserUpload(input);
    default:
      return undefined;
  }
}

const first = (options: readonly ApprovalOption[], kinds: readonly ApprovalOption["kind"][]) => {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return option;
  }
  return undefined;
};

/**
 * The request's options as the three verbs: Allow once is its one-shot grant, Always allow its
 * widest standing one (always, else for this thread), Deny its refusal (deny, else cancel). Any
 * option left over keeps its own words, under Details.
 */
function decide(
  options: readonly ApprovalOption[],
  labels: ToolCopy["labels"],
  defaultToNo: boolean,
): Pick<ApprovalCopy, "decisions" | "others"> {
  const picked: [ApprovalVerb, ApprovalOption | undefined][] = [
    ["allow_once", first(options, ["allow_once"])],
    ["always_allow", first(options, ["allow_always", "allow_session"])],
    ["deny", first(options, ["deny", "cancel", "deny_always"])],
  ];
  let primaryGiven = defaultToNo;
  const decisions: ApprovalDecision[] = [];
  for (const [verb, option] of picked) {
    if (!option) continue;
    const label = verbLabels[verb];
    const words = labels?.[option.id] ?? option.label;
    const emphasis = verb === "deny" ? "quiet" : primaryGiven ? "secondary" : "primary";
    if (verb !== "deny") primaryGiven = true;
    decisions.push({
      verb,
      option,
      label,
      // The provider's words only where they say more than the verb ("Always" doesn't).
      scope:
        verb === "always_allow" && !label.toLowerCase().startsWith(words.toLowerCase())
          ? words
          : undefined,
      emphasis: verb === "always_allow" && emphasis === "secondary" ? "quiet" : emphasis,
    });
  }
  const chosen = new Set(decisions.map((decision) => decision.option.id));
  const others = options
    .filter((option) => !chosen.has(option.id))
    .map((option) => ({ option, label: labels?.[option.id] ?? option.label }));
  return { decisions, others };
}

/** A title that is a whole login-shell invocation reads as the command inside it. */
function shellTitle(title: string): string {
  const inner = unwrapShellCommand(title)?.inner;
  return inner ? `Run ${inner}` : title;
}

/** A shell request's heading: its block shows the command, so the heading doesn't repeat it. */
function heading(title: string, command: string | undefined): string {
  return command && title.includes(command) ? "Run this command?" : title;
}

const highRisk: readonly RegExp[] = [
  /\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/,
  /\bsudo\b/,
  /\bdrop\s+(table|database)\b/i,
  /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/,
  /\bchmod\s+-R\b/,
];
const mediumRisk: readonly RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(add|install|i)\b/,
  /\b(pip|pip3|brew|cargo|gem)\s+(install|add)\b/,
  /\bgit\s+push\b/,
  /\b(curl|wget)\b/,
  /\bdocker\s+(run|rm|system\s+prune)\b/,
];

/**
 * How careful to be with a shell command, from its text alone. Only commands that rewrite
 * history, delete recursively, escalate privileges or reach the network get a level.
 */
export function commandRisk(command: string): ApprovalCopy["risk"] {
  if (highRisk.some((pattern) => pattern.test(command)))
    return { level: "high", text: "Hard to undo. Read the command before you allow it." };
  if (mediumRisk.some((pattern) => pattern.test(command)))
    return { level: "medium", text: "It reaches the network or changes what's installed." };
  return undefined;
}

/**
 * A request's card preserves the native harness's offered scopes. ace tools retain their
 * independent human-consent options.
 */
export function approvalCopy(
  request: ApprovalRequest,
  context: {
    mode?: Parameters<typeof offeredOptions>[1];
    /** The command of the step that asked, when it is a shell step. */
    command?: string | undefined;
    /** ace's review, whose reason is the card's when the request gives none. */
    review?: Pick<PermissionReview, "reason" | "decision"> | undefined;
  } = {},
): ApprovalCopy {
  const copy = toolCopy(request);
  const defaultToNo = request.defaultToNo === true;
  const options = copy ? request.options : offeredOptions(request.options, context.mode).options;
  const target = request.target?.command;
  const command = copy
    ? undefined
    : (context.command ?? (target ? displayCommand({ command: target }).command : undefined));
  const title = copy?.title ?? shellTitle(request.title);
  return {
    tool: copy ? request.target?.tool : undefined,
    title,
    heading: copy ? title : heading(title, command),
    command,
    app: copy?.app,
    reason: copy
      ? copy.reason
      : (request.description ??
        (context.review?.decision === "escalate" ? reviewReason(context.review) : undefined)),
    risk: copy?.risk ?? (command ? commandRisk(command) : undefined),
    facts: copy?.facts ?? [],
    code: copy?.code,
    files: copy?.files ?? [],
    ...decide(options, copy?.labels, defaultToNo),
    defaultToNo,
  };
}

/**
 * Whether a key may pick `option`. A request that defaults to no takes a key only to refuse;
 * approving it is a click (or Enter on the focused button), never a reflex key.
 */
export function approvalByKey(request: ApprovalRequest, option: ApprovalOption): boolean {
  return request.defaultToNo !== true || refusal(option);
}

/**
 * A request to answer on its full card, never with a one-tap Approve from a list: ace's own
 * tools and anything that defaults to no.
 */
export function deliberateApproval(request: InteractionRequest): boolean {
  return (
    request.kind === "approval" &&
    (request.defaultToNo === true || approvalCopy(request).tool !== undefined)
  );
}

/**
 * The daemon's hold on an agent while a person keeps the thread's browser private. It closes
 * only when the person hands the browser back (or closes it), never by answering it.
 */
export function privateBrowserGate(interaction: { raw: readonly { type: string }[] }): boolean {
  return interaction.raw.some((raw) => raw.type === "ace.browser.private");
}
