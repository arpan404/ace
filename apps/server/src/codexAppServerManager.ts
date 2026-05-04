import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  ProviderRequestKind,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  RuntimeMode,
  ProviderInteractionMode,
  type BrowserBridgeOperation,
} from "@ace/contracts";
import { normalizeModelSlug } from "@ace/shared/model";
import { Effect, ServiceMap } from "effect";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "./provider/codexCliVersion";
import {
  CODEX_SPARK_MODEL,
  readCodexAccountSnapshot,
  resolveCodexModelForAccount,
  type CodexAccountSnapshot,
} from "./provider/codexAccount";
import { buildCodexInitializeParams, killCodexChildProcess } from "./provider/codexAppServer";
import { browserBridge } from "./browserBridge";
import { isIosSimulatorBridgeOperation, runIosSimulatorBridgeRequest } from "./iosSimulatorBridge";

export { buildCodexInitializeParams } from "./provider/codexAppServer";
export { readCodexAccountSnapshot, resolveCodexModelForAccount } from "./provider/codexAccount";

type PendingRequestKey = string;

interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/fileRead/requestApproval";
  requestKind: ProviderRequestKind;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

interface PendingUserInputRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

interface CodexDynamicToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly deferLoading?: boolean;
}

interface CodexRuntimeModelInfo {
  readonly slug: string;
  readonly supportsImageGeneration: boolean;
  readonly isDefault: boolean;
}

interface CodexUserInputAnswer {
  answers: string[];
}

interface CodexSessionContext {
  session: ProviderSession;
  account: CodexAccountSnapshot;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  collabReceiverTurns: Map<string, TurnId>;
  modelsBySlug: Map<string, CodexRuntimeModelInfo>;
  nextRequestId: number;
  stopping: boolean;
  imageGenerationPreflightEnabled: boolean;
}

interface JsonRpcError {
  code?: number;
  message?: string;
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{ type: "image"; url: string }>;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly effort?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexAppServerSteerTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{ type: "image"; url: string }>;
}

export interface CodexAppServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "codex";
  readonly cwd?: string;
  readonly model?: string;
  readonly serviceTier?: string;
  readonly resumeCursor?: unknown;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly runtimeMode: RuntimeMode;
}

export interface CodexThreadTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface CodexThreadSnapshot {
  threadId: string;
  turns: CodexThreadTurnSnapshot[];
}

const CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000;

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
  "no rollout found",
  "missing rollout",
  "rollout not found",
];
const CODEX_IMAGE_GENERATION_PREFLIGHT_TOOL_NAME = "image_generation_prehook";
const CODEX_IMAGE_GENERATION_PREFLIGHT_TOOL_NAMES = new Set([
  "image generation prehook",
  "imagegen",
  "image gen",
  "image generation",
]);
const CODEX_IMAGE_GENERATION_PREFLIGHT_INSTRUCTIONS = `
## Image Generation Preflight

When you are about to create or edit a raster image with the native image generation capability, first call the \`${CODEX_IMAGE_GENERATION_PREFLIGHT_TOOL_NAME}\` tool exactly once for that image request. This tool only opens Ace's live image placeholder; it does not create the image. After it returns, continue with the native image generation capability and do not treat the preflight tool result as the final answer.
`.trim();
const CODEX_IMAGE_GENERATION_PREFLIGHT_TOOL: CodexDynamicToolSpec = {
  name: CODEX_IMAGE_GENERATION_PREFLIGHT_TOOL_NAME,
  description:
    "Open Ace's live image-generation placeholder before using the native image generation capability. This tool does not generate an image; call it once immediately before native raster image generation.",
  inputSchema: {
    type: "object",
    additionalProperties: true,
    properties: {
      prompt: {
        type: "string",
        description: "Brief description of the image that will be generated.",
      },
      size: {
        type: "string",
        description: "Requested image dimensions, such as 1536x1024 or 1024x1536.",
      },
      width: {
        type: "number",
        description: "Requested image width in pixels, when known.",
      },
      height: {
        type: "number",
        description: "Requested image height in pixels, when known.",
      },
      aspectRatio: {
        type: "string",
        description: "Requested aspect ratio, when known.",
      },
    },
  },
};
const CODEX_BROWSER_BRIDGE_TOOL_NAME = "ace_browser";
const CODEX_BROWSER_BRIDGE_TOOL_NAMES = new Set(["ace browser", "ace_browser"]);
const CODEX_BROWSER_BRIDGE_OPERATIONS: readonly BrowserBridgeOperation[] = [
  "open_url",
  "navigate_tab_url",
  "list_tabs",
  "selected_tab",
  "get_tab",
  "select_tab",
  "switch_tab",
  "activate_tab",
  "next_tab",
  "previous_tab",
  "select_next_tab",
  "select_previous_tab",
  "create_tab",
  "new_tab",
  "close_tab",
  "dom_snapshot",
  "playwright_dom_snapshot",
  "dom_cua_get_visible_dom",
  "screenshot",
  "playwright_screenshot",
  "cua_get_visible_screenshot",
  "click",
  "cua_click",
  "cua_double_click",
  "cua_drag",
  "cua_keypress",
  "cua_move",
  "cua_scroll",
  "cua_type",
  "dom_cua_click",
  "dom_cua_double_click",
  "dom_cua_keypress",
  "dom_cua_scroll",
  "dom_cua_type",
  "fill",
  "playwright_locator_click",
  "playwright_locator_count",
  "playwright_locator_dblclick",
  "playwright_locator_fill",
  "playwright_locator_get_attribute",
  "playwright_locator_inner_text",
  "playwright_locator_is_enabled",
  "playwright_locator_is_visible",
  "playwright_locator_press",
  "playwright_locator_select_option",
  "playwright_locator_set_checked",
  "playwright_locator_text_content",
  "playwright_locator_wait_for",
  "playwright_wait_for_load_state",
  "playwright_wait_for_timeout",
  "playwright_wait_for_url",
  "tab_clipboard_read_text",
  "tab_clipboard_write_text",
  "tab_dev_logs",
  "ios_simulator_list_devices",
  "ios_simulator_boot",
  "ios_simulator_shutdown",
  "ios_simulator_open_url",
  "ios_simulator_launch_app",
  "ios_simulator_terminate_app",
  "ios_simulator_screenshot",
  "set_viewport_size",
  "resize_browser",
  "get_viewport_size",
  "get_browser_zoom",
  "set_browser_zoom",
  "reset_browser_zoom",
  "zoom_browser",
  "name_session",
  "back",
  "navigate_tab_back",
  "forward",
  "navigate_tab_forward",
  "reload",
  "navigate_tab_reload",
];
const CODEX_BROWSER_BRIDGE_INSTRUCTIONS = `
## Ace Browser Bridge

When you need browser automation, use the \`${CODEX_BROWSER_BRIDGE_TOOL_NAME}\` dynamic tool. It controls Ace's in-app browser for this thread. Prefer it over any separate/native browser surface when opening pages, inspecting DOM, taking screenshots, clicking, filling, typing, scrolling, navigating tabs, reading clipboard text, or reading console logs.

Use the native iOS simulator operations in this same tool for simulator control workflows:
- ios_simulator_list_devices
- ios_simulator_boot
- ios_simulator_shutdown
- ios_simulator_open_url
- ios_simulator_launch_app
- ios_simulator_terminate_app
- ios_simulator_screenshot

If the user selected or refers to Browser Use, browser-use, or an in-app browser skill/plugin, fulfill those browser actions through \`${CODEX_BROWSER_BRIDGE_TOOL_NAME}\`. Do not bootstrap a separate browser-client runtime or use Codex's native browser for Ace browser tasks.

Use the official Browser Use operation names when possible: navigate_tab_url, create_tab, selected_tab, list_tabs, close_tab, playwright_dom_snapshot, playwright_screenshot, playwright_locator_*, dom_cua_*, cua_*, tab_clipboard_*, tab_dev_logs, and wait operations. Use select_tab/switch_tab/activate_tab with tabId or index when you need to move between existing tabs, or next_tab/previous_tab for adjacent tab selection. When opening the first URL, use navigate_tab_url or open_url on the selected tab; Ace reuses the initial blank tab instead of leaving an extra "New tab" behind. Use set_viewport_size or resize_browser with a width when testing responsive layouts; Ace will resize the right browser panel and report the resulting viewport. Use get_browser_zoom, set_browser_zoom, reset_browser_zoom, or zoom_browser when zoom matters. You may also use the shorter compatibility names open_url, dom_snapshot, screenshot, click, fill, back, forward, and reload.

Use playwright_dom_snapshot for readable page content and locator ground truth. Use dom_cua_get_visible_dom when you need node ids for DOM CUA actions. For page scrolling, prefer dom_cua_scroll with x/y deltas or cua_scroll with scrollX/scrollY and viewport coordinates; do not use cua_keypress or dom_cua_keypress for page scrolling unless a focused control explicitly needs a keypress.

Screenshots are normalized to the browser viewport's CSS-pixel coordinate space. Use the returned pageViewport, browserZoomFactor, and coordinateSpace metadata before coordinate-based CUA actions if the Ace app or in-app browser is zoomed.

Do not request Browser Use site-access approval for pages controlled through Ace's in-app browser bridge. The bridge is the browser surface for this thread.
`.trim();
const CODEX_BROWSER_BRIDGE_TOOL: CodexDynamicToolSpec = {
  name: CODEX_BROWSER_BRIDGE_TOOL_NAME,
  description: "Control Ace's in-app browser for this thread with Browser Use-style operations.",
  inputSchema: {
    type: "object",
    additionalProperties: true,
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: [...CODEX_BROWSER_BRIDGE_OPERATIONS],
        description: "Browser operation to run.",
      },
      url: {
        type: "string",
        description: "URL for open_url or navigate_tab_url.",
      },
      newTab: {
        type: "boolean",
        description: "Open the URL in a new in-app browser tab.",
      },
      tabId: {
        type: "string",
        description: "Optional target Ace browser tab id. Defaults to the selected tab.",
      },
      tab_id: {
        type: "string",
        description: "Browser Use-style tab id alias.",
      },
      index: {
        type: "number",
        description: "Zero-based tab index for select_tab/switch_tab/activate_tab.",
      },
      tabIndex: {
        type: "number",
        description: "Zero-based tab index alias.",
      },
      tabNumber: {
        type: "number",
        description: "One-based tab number alias.",
      },
      forceNewTab: {
        type: "boolean",
        description:
          "Force create_tab/open_url to create a new tab even when the initial blank tab can be reused.",
      },
      selector: {
        type: "string",
        description: "CSS selector for locator operations.",
      },
      node_id: {
        type: "string",
        description: "DOM node id from dom_cua_get_visible_dom.",
      },
      x: {
        type: "number",
        description: "Viewport x coordinate for CUA operations.",
      },
      y: {
        type: "number",
        description: "Viewport y coordinate for CUA operations.",
      },
      scrollX: {
        type: "number",
        description: "Horizontal scroll delta for Browser Use scroll operations.",
      },
      scrollY: {
        type: "number",
        description: "Vertical scroll delta for Browser Use scroll operations.",
      },
      width: {
        type: "number",
        description: "Requested browser viewport width in CSS pixels for set_viewport_size.",
      },
      height: {
        type: "number",
        description:
          "Requested browser viewport height in CSS pixels. Ace reports the actual available height.",
      },
      panelWidth: {
        type: "number",
        description: "Requested Ace right side browser panel width in CSS pixels.",
      },
      rightSidePanelWidth: {
        type: "number",
        description: "Alias for panelWidth.",
      },
      zoomFactor: {
        type: "number",
        description: "Requested browser zoom factor for set_browser_zoom or zoom_browser.",
      },
      factor: {
        type: "number",
        description: "Alias for zoomFactor.",
      },
      zoom: {
        type: "number",
        description: "Alias for zoomFactor.",
      },
      delta: {
        type: "number",
        description: "Relative zoom delta for zoom_browser, such as 0.1 or -0.1.",
      },
      value: {
        type: "string",
        description: "Value for fill, typing, keypress, attribute name, or select option.",
      },
      keys: {
        type: "array",
        items: {
          type: "string",
        },
        description: "Key names for Browser Use keypress operations.",
      },
      text: {
        type: "string",
        description: "Text matcher or text to type.",
      },
      timeoutMs: {
        type: "number",
        description: "Optional timeout in milliseconds.",
      },
    },
  },
};
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBooleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asUnknownArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function messageFromUnknownError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Plan Mode (Conversational)

You work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed-intent- and implementation-wise-so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.

## Mode rules (strict)

You are in **Plan Mode** until a developer message explicitly ends it.

Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to **plan the execution**, not perform it.

## Plan Mode vs update_plan tool

Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a \`<proposed_plan>\` block.

Separately, \`update_plan\` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode. Do not confuse it with Plan mode or try to use it while in Plan mode. If you try to use \`update_plan\` in Plan mode, it will return an error.

## Execution vs. mutation in Plan Mode

You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

### Allowed (non-mutating, plan-improving)

Actions that gather truth, reduce ambiguity, or validate feasibility without changing repo-tracked state. Examples:

* Reading or searching files, configs, schemas, types, manifests, and docs
* Static analysis, inspection, and repo exploration
* Dry-run style commands when they do not edit repo-tracked files
* Tests, builds, or checks that may write to caches or build artifacts (for example, \`target/\`, \`.cache/\`, or snapshots) so long as they do not edit repo-tracked files

### Not allowed (mutating, plan-executing)

Actions that implement the plan or change repo-tracked state. Examples:

* Editing or writing files
* Running formatters or linters that rewrite files
* Applying patches, migrations, or codegen that updates repo-tracked files
* Side-effectful commands whose purpose is to carry out the plan rather than refine it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## PHASE 1 - Ground in the environment (explore first, ask second)

Begin by grounding yourself in the actual environment. Eliminate unknowns in the prompt by discovering facts, not by asking the user. Resolve all questions that can be answered through exploration or inspection. Identify missing or ambiguous details only if they cannot be derived from the environment. Silent exploration between turns is allowed and encouraged.

Before asking the user any question, perform at least one targeted non-mutating exploration pass (for example: search relevant files, inspect likely entrypoints/configs, confirm current implementation shape), unless no local environment/repo is available.

Exception: you may ask clarifying questions about the user's prompt before exploring, ONLY if there are obvious ambiguities or contradictions in the prompt itself. However, if ambiguity might be resolved by exploring, always prefer exploring first.

Do not ask questions that can be answered from the repo or system (for example, "where is this struct?" or "which UI component should we use?" when exploration can make it clear). Only ask once you have exhausted reasonable non-mutating exploration.

## PHASE 2 - Intent chat (what they actually want)

* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet-ask.

## PHASE 3 - Implementation chat (what/how we'll build)

* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.

## Asking questions

Critical rules:

* Strongly prefer using the \`request_user_input\` tool to ask any questions.
* Offer only meaningful multiple-choice options; don't include filler choices that are obviously wrong or irrelevant.
* In rare cases where an unavoidable, important question can't be expressed with reasonable multiple-choice options (due to extreme ambiguity), you may ask it directly without the tool.

You SHOULD ask many questions, but each question must:

* materially change the spec/plan, OR
* confirm/lock an assumption, OR
* choose between meaningful tradeoffs.
* not be answerable by non-mutating commands.

Use the \`request_user_input\` tool only for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.

## Two kinds of unknowns (treat differently)

1. **Discoverable facts** (repo/system truth): explore first.

   * Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants).
   * Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent.
   * If asking, present concrete candidates (paths/service names) + recommend one.
   * Never ask questions you can answer from your environment (e.g., "where is this struct").

2. **Preferences/tradeoffs** (not discoverable): ask early.

   * These are intent or implementation preferences that cannot be derived from exploration.
   * Provide 2-4 mutually exclusive options + a recommended default.
   * If unanswered, proceed with the recommended option and record it as an assumption in the final plan.

## Finalization rule

Only output the final plan when it is decision complete and leaves no decisions to the implementer.

When you present the official plan, wrap it in a \`<proposed_plan>\` block so the client can render it specially:

1) The opening tag must be on its own line.
2) Start the plan content on the next line (no text on the same line as the tag).
3) The closing tag must be on its own line.
4) Use Markdown inside the block.
5) Keep the tags exactly as \`<proposed_plan>\` and \`</proposed_plan>\` (do not translate or rename them), even if the plan content is in another language.

Example:

<proposed_plan>
plan content
</proposed_plan>

plan content should be human and agent digestible. The final plan must be plan-only and include:

* A clear title
* A brief summary section
* Important changes or additions to public APIs/interfaces/types
* Test cases and scenarios
* Explicit assumptions and defaults chosen where needed

Do not ask "should I proceed?" in the final output. The user can easily switch out of Plan mode and request implementation if you have included a \`<proposed_plan>\` block in your response. Alternatively, they can decide to stay in Plan mode and continue refining the plan.

Only produce at most one \`<proposed_plan>\` block per turn, and only when you are presenting a complete spec.
</collaboration_mode>`;

export const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different \`<collaboration_mode>...</collaboration_mode>\` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## request_user_input availability

The \`request_user_input\` tool is unavailable in Default mode. If you call it while in Default mode, it will return an error.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
</collaboration_mode>`;

function withAceDynamicToolInstructions(instructions: string): string {
  const extraInstructions = [
    CODEX_IMAGE_GENERATION_PREFLIGHT_INSTRUCTIONS,
    CODEX_BROWSER_BRIDGE_INSTRUCTIONS,
  ].filter((instruction) => !instructions.includes(instruction));

  if (extraInstructions.length === 0) {
    return instructions;
  }

  return `${instructions}\n\n${extraInstructions.join("\n\n")}`;
}

function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: "on-request" | "never";
  readonly sandbox: "workspace-write" | "danger-full-access";
} {
  if (runtimeMode === "approval-required") {
    return {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };
  }

  return {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
}

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
function killChildTree(child: ChildProcessWithoutNullStreams): void {
  killCodexChildProcess(child);
}

export function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }

  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }

  return normalized;
}

export function readCodexRuntimeModels(response: unknown): Map<string, CodexRuntimeModelInfo> {
  const record = asRecord(response);
  const entries =
    asUnknownArray(response) ??
    asUnknownArray(record?.data) ??
    asUnknownArray(record?.models) ??
    asUnknownArray(record?.items) ??
    [];
  const models = new Map<string, CodexRuntimeModelInfo>();

  for (const entry of entries) {
    const model = asRecord(entry);
    if (!model) {
      continue;
    }

    const id = asStringValue(model.id);
    const modelName = asStringValue(model.model);
    const slug = normalizeCodexModelSlug(id ?? modelName, id);
    if (!slug) {
      continue;
    }

    const inputModalities =
      asUnknownArray(model.inputModalities) ?? asUnknownArray(model.input_modalities) ?? [];
    const imageGenerationCapability =
      asBooleanValue(model.imageGeneration) ??
      asBooleanValue(model.supportsImageGeneration) ??
      asBooleanValue(asRecord(model.capabilities)?.imageGeneration);
    const supportsImageGeneration =
      inputModalities.length > 0 || imageGenerationCapability !== undefined
        ? inputModalities.some((modality) => asStringValue(modality)?.toLowerCase() === "image") ||
          imageGenerationCapability === true
        : slug !== CODEX_SPARK_MODEL;

    models.set(slug, {
      slug,
      supportsImageGeneration,
      isDefault: asBooleanValue(model.isDefault) === true,
    });
  }

  return models;
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: "default" | "plan";
  readonly model?: string;
  readonly effort?: string;
  readonly imageGenerationPreflightEnabled?: boolean;
}):
  | {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort: string;
        developer_instructions: string;
      };
    }
  | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? "gpt-5.3-codex";
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions: input.imageGenerationPreflightEnabled
        ? withAceDynamicToolInstructions(
            input.interactionMode === "plan"
              ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
              : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
          )
        : input.interactionMode === "plan"
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    },
  };
}

function toCodexUserInputAnswer(value: unknown): CodexUserInputAnswer {
  if (typeof value === "string") {
    return { answers: [value] };
  }

  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return { answers };
  }

  if (value && typeof value === "object") {
    const maybeAnswers = (value as { answers?: unknown }).answers;
    if (Array.isArray(maybeAnswers)) {
      const answers = maybeAnswers.filter((entry): entry is string => typeof entry === "string");
      return { answers };
    }
  }

  throw new Error("User input answers must be strings or arrays of strings.");
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, CodexUserInputAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      toCodexUserInputAnswer(value),
    ]),
  );
}

export function classifyCodexStderrLine(rawLine: string): { message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }

    const isBenignError = BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet));
    if (isBenignError) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread/resume")) {
    return false;
  }

  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

export interface CodexAppServerManagerEvents {
  event: [event: ProviderEvent];
}

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, CodexSessionContext>();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  constructor(services?: ServiceMap.ServiceMap<never>) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;

    try {
      const resolvedCwd = input.cwd ?? process.cwd();
      this.replaceExistingSession(threadId);

      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model: normalizeCodexModelSlug(input.model),
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexBinaryPath = input.binaryPath;
      const codexHomePath = input.homePath;
      this.assertSupportedCodexCliVersion({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });
      const child = spawn(codexBinaryPath, ["app-server"], {
        cwd: resolvedCwd,
        env: {
          ...process.env,
          ...(codexHomePath ? { CODEX_HOME: codexHomePath } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      const output = readline.createInterface({ input: child.stdout });

      context = {
        session,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        child,
        output,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        modelsBySlug: new Map(),
        nextRequestId: 1,
        stopping: false,
        imageGenerationPreflightEnabled: false,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(context, "initialize", buildCodexInitializeParams());

      this.writeMessage(context, { method: "initialized" });
      try {
        const modelListResponse = await this.sendRequest(context, "model/list", {});
        context.modelsBySlug = readCodexRuntimeModels(modelListResponse);
      } catch (error) {
        this.emitLifecycleEvent(
          context,
          "session/model-list-warning",
          `Failed to load model list: ${messageFromUnknownError(error)}`,
        );
      }
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        context.account = readCodexAccountSnapshot(accountReadResponse);
      } catch (error) {
        this.emitLifecycleEvent(
          context,
          "session/account-warning",
          `Failed to read account state: ${messageFromUnknownError(error)}`,
        );
      }

      const normalizedModel = resolveCodexModelForAccount(
        normalizeCodexModelSlug(input.model),
        context.account,
      );
      const sessionOverrides = {
        model: normalizedModel ?? null,
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        cwd: input.cwd ?? null,
        ...mapCodexRuntimeMode(input.runtimeMode ?? "full-access"),
      };

      const threadStartParams = {
        ...sessionOverrides,
        developerInstructions: [
          CODEX_IMAGE_GENERATION_PREFLIGHT_INSTRUCTIONS,
          CODEX_BROWSER_BRIDGE_INSTRUCTIONS,
        ].join("\n\n"),
        dynamicTools: [CODEX_IMAGE_GENERATION_PREFLIGHT_TOOL, CODEX_BROWSER_BRIDGE_TOOL],
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      };
      const resumeThreadId = readResumeThreadId(input);
      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        resumeThreadId
          ? `Attempting to resume thread ${resumeThreadId}.`
          : "Starting a new Codex thread.",
      );
      await Effect.logInfo("codex app-server opening thread", {
        threadId,
        requestedRuntimeMode: input.runtimeMode,
        requestedModel: normalizedModel ?? null,
        requestedCwd: resolvedCwd,
        resumeThreadId: resumeThreadId ?? null,
      }).pipe(this.runPromise);

      let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
      let threadOpenResponse: unknown;
      if (resumeThreadId) {
        try {
          threadOpenMethod = "thread/resume";
          threadOpenResponse = await this.sendRequest(context, "thread/resume", {
            ...sessionOverrides,
            threadId: resumeThreadId,
          });
        } catch (error) {
          if (!isRecoverableThreadResumeError(error)) {
            this.emitErrorEvent(
              context,
              "session/threadResumeFailed",
              error instanceof Error ? error.message : "Codex thread resume failed.",
            );
            await Effect.logWarning("codex app-server thread resume failed", {
              threadId,
              requestedRuntimeMode: input.runtimeMode,
              resumeThreadId,
              recoverable: false,
              cause: error instanceof Error ? error.message : String(error),
            }).pipe(this.runPromise);
            throw error;
          }

          threadOpenMethod = "thread/start";
          context.imageGenerationPreflightEnabled = true;
          this.emitLifecycleEvent(
            context,
            "session/threadResumeFallback",
            `Could not resume thread ${resumeThreadId}; started a new thread instead.`,
          );
          await Effect.logWarning("codex app-server thread resume fell back to fresh start", {
            threadId,
            requestedRuntimeMode: input.runtimeMode,
            resumeThreadId,
            recoverable: true,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
          threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
        }
      } else {
        threadOpenMethod = "thread/start";
        context.imageGenerationPreflightEnabled = true;
        threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
      }

      const threadOpenRecord = this.readObject(threadOpenResponse);
      const threadIdRaw =
        this.readString(this.readObject(threadOpenRecord, "thread"), "id") ??
        this.readString(threadOpenRecord, "threadId");
      if (!threadIdRaw) {
        throw new Error(`${threadOpenMethod} response did not include a thread id.`);
      }
      const providerThreadId = threadIdRaw;

      this.updateSession(context, {
        status: "ready",
        resumeCursor: { threadId: providerThreadId },
      });
      this.emitLifecycleEvent(
        context,
        "session/threadOpenResolved",
        `Codex ${threadOpenMethod} resolved.`,
      );
      await Effect.logInfo("codex app-server thread open resolved", {
        threadId,
        threadOpenMethod,
        requestedResumeThreadId: resumeThreadId ?? null,
        resolvedThreadId: providerThreadId,
        requestedRuntimeMode: input.runtimeMode,
      }).pipe(this.runPromise);
      this.emitLifecycleEvent(context, "session/ready", `Connected to thread ${providerThreadId}`);
      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Codex session.";
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/startFailed", message);
        this.stopSession(threadId);
      } else {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "error",
          provider: "codex",
          threadId,
          createdAt: new Date().toISOString(),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    context.collabReceiverTurns.clear();

    const turnInput: Array<
      { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
    > = [];
    if (input.input) {
      turnInput.push({
        type: "text",
        text: input.input,
        text_elements: [],
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        turnInput.push({
          type: "image",
          url: attachment.url,
        });
      }
    }
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }
    const turnStartParams: {
      threadId: string;
      input: Array<
        { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
      >;
      model?: string;
      serviceTier?: string | null;
      effort?: string;
      collaborationMode?: {
        mode: "default" | "plan";
        settings: {
          model: string;
          reasoning_effort: string;
          developer_instructions: string;
        };
      };
    } = {
      threadId: providerThreadId,
      input: turnInput,
    };
    const requestedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model ?? context.session.model),
      context.account,
    );
    if (requestedModel) {
      turnStartParams.model = requestedModel;
    }
    if (input.serviceTier !== undefined) {
      turnStartParams.serviceTier = input.serviceTier;
    }
    if (input.effort) {
      turnStartParams.effort = input.effort;
    }
    const collaborationMode = buildCodexCollaborationMode({
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(requestedModel !== undefined ? { model: requestedModel } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      imageGenerationPreflightEnabled: context.imageGenerationPreflightEnabled,
    });
    if (collaborationMode) {
      if (!turnStartParams.model) {
        turnStartParams.model = collaborationMode.settings.model;
      }
      turnStartParams.collaborationMode = collaborationMode;
    }

    const response = await this.sendRequest(context, "turn/start", turnStartParams);

    const turn = this.readObject(this.readObject(response), "turn");
    const turnIdRaw = this.readString(turn, "id");
    if (!turnIdRaw) {
      throw new Error("turn/start response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async steerTurn(input: CodexAppServerSteerTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    const activeTurnId = context.session.activeTurnId;
    if (!activeTurnId) {
      throw new Error("Session has no active turn to steer.");
    }

    const turnInput: Array<
      { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
    > = [];
    if (input.input) {
      turnInput.push({
        type: "text",
        text: input.input,
        text_elements: [],
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        turnInput.push({
          type: "image",
          url: attachment.url,
        });
      }
    }
    if (turnInput.length === 0) {
      throw new Error("Turn steer input must include text or attachments.");
    }

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }

    const response = await this.sendRequest(context, "turn/steer", {
      threadId: providerThreadId,
      input: turnInput,
      expectedTurnId: activeTurnId,
    });
    const responseObject = this.readObject(response);
    const resultTurnId = toTurnId(this.readString(responseObject, "turnId"));
    const turnId = resultTurnId ?? activeTurnId;

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);
    const effectiveTurnId = turnId ?? context.session.activeTurnId;

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!effectiveTurnId || !providerThreadId) {
      return;
    }

    await this.sendRequest(context, "turn/interrupt", {
      threadId: providerThreadId,
      turnId: effectiveTurnId,
    });
  }

  async readThread(threadId: ThreadId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(context, "thread/read", {
      threadId: providerThreadId,
      includeTurns: true,
    });
    return this.parseThreadSnapshot("thread/read", response);
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1.");
    }

    const response = await this.sendRequest(context, "thread/rollback", {
      threadId: providerThreadId,
      numTurns,
    });
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    return this.parseThreadSnapshot("thread/rollback", response);
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingApprovals.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        decision,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      payload: {
        requestId: pendingRequest.requestId,
        requestKind: pendingRequest.requestKind,
        decision,
      },
    });
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingUserInputs.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending user input request: ${requestId}`);
    }

    context.pendingUserInputs.delete(requestId);
    const codexAnswers = toCodexUserInputAnswers(answers);
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        answers: codexAnswers,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/tool/requestUserInput/answered",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      payload: {
        requestId: pendingRequest.requestId,
        answers: codexAnswers,
      },
    });
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    context.stopping = true;

    this.rejectPendingRequests(context, "Session stopped before request completed.");
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();

    context.output.close();

    if (!context.child.killed) {
      killChildTree(context.child);
    }

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    this.sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({
      ...session,
    }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  private replaceExistingSession(threadId: ThreadId): void {
    const existing = this.sessions.get(threadId);
    if (!existing || existing.session.status === "closed") {
      return;
    }

    this.stopSession(threadId);
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  private requireSession(threadId: ThreadId): CodexSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }

    if (context.session.status === "closed") {
      throw new Error(`Session is closed for thread: ${threadId}`);
    }

    return context;
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    context.output.on("line", (line) => {
      this.handleStdoutLine(context, line);
    });

    context.child.stderr.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      const lines = raw.split(/\r?\n/g);
      for (const rawLine of lines) {
        const classified = classifyCodexStderrLine(rawLine);
        if (!classified) {
          continue;
        }

        this.emitNotificationEvent(context, "process/stderr", classified.message);
      }
    });

    context.child.on("error", (error) => {
      const message = error.message || "codex app-server process errored.";
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.emitErrorEvent(context, "process/error", message);
    });

    context.child.on("exit", (code, signal) => {
      if (context.stopping) {
        return;
      }

      const message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
        lastError: code === 0 ? context.session.lastError : message,
      });
      this.emitLifecycleEvent(context, "session/exited", message);
      this.sessions.delete(context.session.threadId);
    });
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emitErrorEvent(
        context,
        "protocol/parseError",
        "Received invalid JSON from codex app-server.",
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.emitErrorEvent(
        context,
        "protocol/invalidMessage",
        "Received non-object protocol message.",
      );
      return;
    }

    if (this.isServerRequest(parsed)) {
      this.handleServerRequest(context, parsed);
      return;
    }

    if (this.isServerNotification(parsed)) {
      this.handleServerNotification(context, parsed);
      return;
    }

    if (this.isResponse(parsed)) {
      this.handleResponse(context, parsed);
      return;
    }

    this.emitErrorEvent(
      context,
      "protocol/unrecognizedMessage",
      "Received protocol message in an unknown shape.",
    );
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    const rawRoute = this.readRouteFields(notification.params);
    this.rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
    const childParentTurnId = this.readChildParentTurnId(context, notification.params);
    const isChildConversation = childParentTurnId !== undefined;
    if (
      isChildConversation &&
      this.shouldSuppressChildConversationNotification(notification.method)
    ) {
      return;
    }
    const textDelta =
      notification.method === "item/agentMessage/delta"
        ? this.readString(notification.params, "delta")
        : undefined;

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: notification.method,
      ...((childParentTurnId ?? rawRoute.turnId)
        ? { turnId: childParentTurnId ?? rawRoute.turnId }
        : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      textDelta,
      payload: notification.params,
    });

    if (notification.method === "thread/started") {
      const providerThreadId = normalizeProviderThreadId(
        this.readString(this.readObject(notification.params)?.thread, "id"),
      );
      if (providerThreadId) {
        this.updateSession(context, { resumeCursor: { threadId: providerThreadId } });
      }
      return;
    }

    if (notification.method === "turn/started") {
      if (isChildConversation) {
        return;
      }
      const turnId = toTurnId(this.readString(this.readObject(notification.params)?.turn, "id"));
      this.updateSession(context, {
        status: "running",
        activeTurnId: turnId,
      });
      return;
    }

    if (notification.method === "turn/completed") {
      if (isChildConversation) {
        return;
      }
      if (!this.shouldApplyActiveTurnTerminalNotification(context, rawRoute.turnId)) {
        return;
      }
      context.collabReceiverTurns.clear();
      const turn = this.readObject(notification.params, "turn");
      const status = this.readString(turn, "status");
      const errorMessage = this.readString(this.readObject(turn, "error"), "message");
      this.updateSession(context, {
        status: status === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        lastError: errorMessage ?? context.session.lastError,
      });
      return;
    }

    if (notification.method === "turn/aborted") {
      if (isChildConversation) {
        return;
      }
      if (!this.shouldApplyActiveTurnTerminalNotification(context, rawRoute.turnId)) {
        return;
      }
      context.collabReceiverTurns.clear();
      this.updateSession(context, {
        status: "ready",
        activeTurnId: undefined,
      });
      return;
    }

    if (notification.method === "error") {
      if (isChildConversation) {
        return;
      }
      const message = this.readString(this.readObject(notification.params)?.error, "message");
      const willRetry = this.readBoolean(notification.params, "willRetry");
      const hasUnscopedActiveTurnError =
        context.session.activeTurnId !== undefined && rawRoute.turnId === undefined;

      this.updateSession(context, {
        status: willRetry || hasUnscopedActiveTurnError ? "running" : "error",
        lastError: message ?? context.session.lastError,
      });
    }
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    const rawRoute = this.readRouteFields(request.params);
    const childParentTurnId = this.readChildParentTurnId(context, request.params);
    const effectiveTurnId = childParentTurnId ?? rawRoute.turnId;
    const requestKind = this.requestKindForMethod(request.method);
    let requestId: ApprovalRequestId | undefined;
    if (requestKind) {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      const pendingRequest: PendingApprovalRequest = {
        requestId,
        jsonRpcId: request.id,
        method:
          requestKind === "command"
            ? "item/commandExecution/requestApproval"
            : requestKind === "file-read"
              ? "item/fileRead/requestApproval"
              : "item/fileChange/requestApproval",
        requestKind,
        threadId: context.session.threadId,
        ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      };
      context.pendingApprovals.set(requestId, pendingRequest);
    }

    if (request.method === "item/tool/requestUserInput") {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      context.pendingUserInputs.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        threadId: context.session.threadId,
        ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      });
    }

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "request",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: request.method,
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      requestId,
      requestKind,
      payload: request.params,
    });

    if (requestKind) {
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      return;
    }

    if (this.isImageGenerationPreflightRequest(request)) {
      this.writeMessage(context, {
        id: request.id,
        result: {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: "Ace image generation preflight is active. Continue by using the native image generation capability now; this tool result is not the final image.",
            },
          ],
        },
      });
      return;
    }

    if (this.isAceBrowserBridgeRequest(request)) {
      void this.handleAceBrowserBridgeRequest(context, request);
      return;
    }

    this.writeMessage(context, {
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  private takePendingRequest(
    context: CodexSessionContext,
    id: string | number,
  ): PendingRequest | undefined {
    const key = String(id);
    const pending = context.pending.get(key);
    if (!pending) {
      return undefined;
    }
    clearTimeout(pending.timeout);
    context.pending.delete(key);
    return pending;
  }

  private storePendingRequest(
    context: CodexSessionContext,
    id: string | number,
    pending: PendingRequest,
  ): void {
    context.pending.set(String(id), pending);
  }

  private rejectPendingRequests(context: CodexSessionContext, message: string): void {
    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    context.pending.clear();
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const pending = this.takePendingRequest(context, response.id);
    if (!pending) {
      return;
    }

    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
      return;
    }

    pending.resolve(response.result);
  }

  private async sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
  ): Promise<TResponse> {
    const id = context.nextRequestId;
    context.nextRequestId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.takePendingRequest(context, id);
        if (!pending) {
          return;
        }
        pending.reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      this.storePendingRequest(context, id, {
        method,
        timeout,
        resolve,
        reject,
      });
      this.writeMessage(context, {
        method,
        id,
        params,
      });
    });

    return result as TResponse;
  }

  private writeMessage(context: CodexSessionContext, message: unknown): void {
    const encoded = JSON.stringify(message);
    if (!context.child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }

    context.child.stdin.write(`${encoded}\n`);
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    const processPid = context.child.pid;
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
      ...(typeof processPid === "number" && Number.isInteger(processPid) && processPid > 0
        ? { payload: { processPid } }
        : {}),
    });
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitNotificationEvent(
    context: CodexSessionContext,
    method: string,
    message: string,
  ): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private assertSupportedCodexCliVersion(input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
  }): void {
    assertSupportedCodexCliVersion(input);
  }

  private updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  private requestKindForMethod(method: string): ProviderRequestKind | undefined {
    if (method === "item/commandExecution/requestApproval") {
      return "command";
    }

    if (method === "item/fileRead/requestApproval") {
      return "file-read";
    }

    if (method === "item/fileChange/requestApproval") {
      return "file-change";
    }

    return undefined;
  }

  private isImageGenerationPreflightRequest(request: JsonRpcRequest): boolean {
    if (request.method !== "item/tool/call") {
      return false;
    }

    const tool = this.normalizeDynamicToolName(this.readString(request.params, "tool"));
    return tool !== undefined && CODEX_IMAGE_GENERATION_PREFLIGHT_TOOL_NAMES.has(tool);
  }

  private isAceBrowserBridgeRequest(request: JsonRpcRequest): boolean {
    if (request.method !== "item/tool/call") {
      return false;
    }

    const tool = this.normalizeDynamicToolName(this.readString(request.params, "tool"));
    return tool !== undefined && CODEX_BROWSER_BRIDGE_TOOL_NAMES.has(tool);
  }

  private async handleAceBrowserBridgeRequest(
    context: CodexSessionContext,
    request: JsonRpcRequest,
  ): Promise<void> {
    try {
      const args = this.readObject(request.params, "arguments") ?? {};
      const operation = this.readBrowserBridgeOperation(args);
      if (isIosSimulatorBridgeOperation(operation)) {
        const result = await runIosSimulatorBridgeRequest({ args, operation });
        this.writeMessage(context, {
          id: request.id,
          result: {
            success: true,
            contentItems: this.formatBrowserBridgeContentItems(result),
          },
        });
        return;
      }

      const result = await browserBridge.request({
        args,
        operation,
        threadId: context.session.threadId,
      });

      this.writeMessage(context, {
        id: request.id,
        result: {
          success: true,
          contentItems: this.formatBrowserBridgeContentItems(result),
        },
      });
    } catch (error) {
      this.writeMessage(context, {
        id: request.id,
        result: {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `Ace browser bridge failed: ${messageFromUnknownError(error)}`,
            },
          ],
        },
      });
    }
  }

  private readBrowserBridgeOperation(args: Record<string, unknown>): BrowserBridgeOperation {
    const operation = this.readString(args, "operation");
    if (
      operation &&
      CODEX_BROWSER_BRIDGE_OPERATIONS.includes(operation as BrowserBridgeOperation)
    ) {
      return operation as BrowserBridgeOperation;
    }

    throw new Error("Ace browser bridge request is missing a supported operation.");
  }

  private formatBrowserBridgeContentItems(
    result: Record<string, unknown>,
  ): Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }> {
    const imageDataUrl = typeof result.imageDataUrl === "string" ? result.imageDataUrl : undefined;
    const domSnapshot = typeof result.domSnapshot === "string" ? result.domSnapshot : undefined;
    const textResult: Record<string, unknown> = { ...result };
    delete textResult.domSnapshot;
    delete textResult.imageDataUrl;

    const contentItems: Array<
      { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
    > = [];

    if (domSnapshot) {
      const metadata =
        Object.keys(textResult).length > 0 ? `\n\nMetadata: ${JSON.stringify(textResult)}` : "";
      contentItems.push({
        type: "inputText",
        text: `Ace browser DOM snapshot:\n${domSnapshot}${metadata}`,
      });
    } else {
      contentItems.push({
        type: "inputText",
        text: `Ace browser result: ${JSON.stringify(textResult)}`,
      });
    }

    if (imageDataUrl) {
      contentItems.push({ type: "inputImage", imageUrl: imageDataUrl });
    }

    return contentItems;
  }

  private normalizeDynamicToolName(tool: string | undefined): string | undefined {
    return tool
      ?.trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[._/-]/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  private parseThreadSnapshot(method: string, response: unknown): CodexThreadSnapshot {
    const responseRecord = this.readObject(response);
    const thread = this.readObject(responseRecord, "thread");
    const threadIdRaw =
      this.readString(thread, "id") ?? this.readString(responseRecord, "threadId");
    if (!threadIdRaw) {
      throw new Error(`${method} response did not include a thread id.`);
    }
    const turnsRaw =
      this.readArray(thread, "turns") ?? this.readArray(responseRecord, "turns") ?? [];
    const turns = turnsRaw.map((turnValue, index) => {
      const turn = this.readObject(turnValue);
      const turnIdRaw = this.readString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
      const turnId = TurnId.makeUnsafe(turnIdRaw);
      const items = this.readArray(turn, "items") ?? [];
      return {
        id: turnId,
        items,
      };
    });

    return {
      threadId: threadIdRaw,
      turns,
    };
  }

  private isServerRequest(value: unknown): value is JsonRpcRequest {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.method === "string" &&
      (typeof candidate.id === "string" || typeof candidate.id === "number")
    );
  }

  private isServerNotification(value: unknown): value is JsonRpcNotification {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate.method === "string" && !("id" in candidate);
  }

  private isResponse(value: unknown): value is JsonRpcResponse {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
    const hasMethod = typeof candidate.method === "string";
    return hasId && !hasMethod;
  }

  private readRouteFields(params: unknown): {
    turnId?: TurnId;
    itemId?: ProviderItemId;
  } {
    const route: {
      turnId?: TurnId;
      itemId?: ProviderItemId;
    } = {};

    const turnId = toTurnId(
      this.readString(params, "turnId") ?? this.readString(this.readObject(params, "turn"), "id"),
    );
    const itemId = toProviderItemId(
      this.readString(params, "itemId") ?? this.readString(this.readObject(params, "item"), "id"),
    );

    if (turnId) {
      route.turnId = turnId;
    }

    if (itemId) {
      route.itemId = itemId;
    }

    return route;
  }

  private readProviderConversationId(params: unknown): string | undefined {
    return (
      this.readString(params, "threadId") ??
      this.readString(this.readObject(params, "thread"), "id") ??
      this.readString(params, "conversationId")
    );
  }

  private readChildParentTurnId(context: CodexSessionContext, params: unknown): TurnId | undefined {
    const providerConversationId = this.readProviderConversationId(params);
    if (!providerConversationId) {
      return undefined;
    }
    return context.collabReceiverTurns.get(providerConversationId);
  }

  private rememberCollabReceiverTurns(
    context: CodexSessionContext,
    params: unknown,
    parentTurnId: TurnId | undefined,
  ): void {
    if (!parentTurnId) {
      return;
    }
    const payload = this.readObject(params);
    const item = this.readObject(payload, "item") ?? payload;
    const itemType = this.readString(item, "type") ?? this.readString(item, "kind");
    if (itemType !== "collabAgentToolCall") {
      return;
    }

    const receiverThreadIds =
      this.readArray(item, "receiverThreadIds")
        ?.map((value) => (typeof value === "string" ? value : null))
        .filter((value): value is string => value !== null) ?? [];
    for (const receiverThreadId of receiverThreadIds) {
      context.collabReceiverTurns.set(receiverThreadId, parentTurnId);
    }
  }

  private shouldSuppressChildConversationNotification(method: string): boolean {
    return (
      method === "thread/started" ||
      method === "thread/status/changed" ||
      method === "thread/archived" ||
      method === "thread/unarchived" ||
      method === "thread/closed" ||
      method === "thread/compacted" ||
      method === "thread/name/updated" ||
      method === "thread/tokenUsage/updated" ||
      method === "turn/started" ||
      method === "turn/completed" ||
      method === "turn/aborted" ||
      method === "turn/plan/updated" ||
      method === "item/plan/delta"
    );
  }

  private shouldApplyActiveTurnTerminalNotification(
    context: CodexSessionContext,
    turnId: TurnId | undefined,
  ): boolean {
    const activeTurnId = context.session.activeTurnId;
    if (!activeTurnId) {
      return true;
    }
    if (!turnId) {
      return false;
    }
    return turnId === activeTurnId;
  }

  private readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;

    if (!target || typeof target !== "object") {
      return undefined;
    }

    return target as Record<string, unknown>;
  }

  private readArray(value: unknown, key?: string): unknown[] | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    return Array.isArray(target) ? target : undefined;
  }

  private readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  }

  private readBoolean(value: unknown, key: string): boolean | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "boolean" ? candidate : undefined;
  }
}

function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

function normalizeProviderThreadId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): void {
  const result = spawnSync(input.binaryPath, ["--version"], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
    },
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CODEX_VERSION_CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes("enoent") ||
      lower.includes("command not found") ||
      lower.includes("not found")
    ) {
      throw new Error(`Codex CLI (${input.binaryPath}) is not installed or not executable.`);
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }
}

function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as Record<string, unknown>).threadId;
  return typeof rawThreadId === "string" ? normalizeProviderThreadId(rawThreadId) : undefined;
}

function readResumeThreadId(input: {
  readonly resumeCursor?: unknown;
  readonly threadId?: ThreadId;
  readonly runtimeMode?: RuntimeMode;
}): string | undefined {
  return readResumeCursorThreadId(input.resumeCursor);
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return brandIfNonEmpty(value, TurnId.makeUnsafe);
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemId.makeUnsafe);
}
