import type { ApprovalOption, InteractionRequest } from "@ace/protocol";
import { alwaysAsks, appName } from "./app-names.ts";
import { addressHost } from "./browser-address.ts";

/*
 * How an approval reads on a card, in the thread and in Activity alike. ace's own tools
 * (computer use, browser scripts, downloads and uploads) say what they will do and what that
 * risks in a sentence each; any other request keeps the provider's own title and options.
 */

type ApprovalRequest = Extract<InteractionRequest, { kind: "approval" }>;

export interface ApprovalFact {
  label: string;
  value: string;
  /** Show in monospace: bundle ids, paths, addresses. */
  code: boolean;
}

export interface ApprovalChoice {
  option: ApprovalOption;
  /** The button's words: the tool's own when ace knows it, else the provider's. */
  label: string;
  /**
   * `primary` is the one filled button, `secondary` the others that say yes, `quiet` a refusal.
   * A request that defaults to no has no primary: nothing invites a reflex approval.
   */
  emphasis: "primary" | "secondary" | "quiet";
}

export interface ApprovalCopy {
  /** A known ace tool (`screen_request_app`, `browser.evaluate`, ...) or undefined. */
  tool: string | undefined;
  title: string;
  /** What the agent said it needs this for, when it said. */
  reason: string | undefined;
  /** What approving lets happen, honestly and briefly. `high` reads in the failure tone. */
  risk: { level: "high" | "medium"; text: string } | undefined;
  facts: ApprovalFact[];
  /** Code the person is asked to run, shown verbatim (a page script). */
  code: string | undefined;
  /** Every file an approval would hand over (an upload), in full: none is summarised away. */
  files: readonly string[];
  choices: ApprovalChoice[];
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
  reason?: string | undefined;
  risk?: ApprovalCopy["risk"];
  facts?: ApprovalFact[];
  code?: string | undefined;
  files?: readonly string[];
  labels?: Partial<Record<string, string>>;
}

function screenApp(input: Record<string, unknown>, description: string | undefined): ToolCopy {
  const bundleId = text(input["bundleId"]) ?? "";
  const name = appName(bundleId);
  const sensitive = alwaysAsks(bundleId);
  return {
    title: `Let an agent use ${name}`,
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
    facts: [{ label: "App", value: bundleId, code: true }],
    labels: {
      allow_once: "Allow this turn",
      allow_thread: "Allow for this thread",
      allow_always: sensitive ? "Allow, ask each turn" : "Always allow",
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
    reason: description,
    risk: {
      level: "high",
      text: `It will use your real cursor and keyboard in ${name}. Avoid typing until it hands back; you can take over at any time.`,
    },
    facts: [{ label: "App", value: bundleId, code: true }],
    labels: { allow_once: "Allow for this session" },
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
    labels: {
      allow_once: "Run once",
      allow_site: `Allow read-only scripts on ${site}`,
    },
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
    labels: { allow_once: "Allow download" },
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
    labels: { allow_once: "Allow upload" },
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

/** A request's card: its title, risk, the facts it acts on and its buttons in order. */
export function approvalCopy(request: ApprovalRequest): ApprovalCopy {
  const copy = toolCopy(request);
  const defaultToNo = request.defaultToNo === true;
  let primaryGiven = defaultToNo;
  const choices = request.options.map((option): ApprovalChoice => {
    const label = copy?.labels?.[option.id] ?? option.label;
    if (refusal(option)) return { option, label, emphasis: "quiet" };
    const emphasis = primaryGiven ? "secondary" : "primary";
    primaryGiven = true;
    return { option, label, emphasis };
  });
  return {
    tool: copy ? request.target?.tool : undefined,
    title: copy?.title ?? request.title,
    reason: copy ? copy.reason : undefined,
    risk: copy?.risk,
    facts: copy?.facts ?? [],
    code: copy?.code,
    files: copy?.files ?? [],
    choices,
    defaultToNo,
  };
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
