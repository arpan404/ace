import { say, str, quote, verbs, type AceToolSpec, type ToolWords } from "./ace-tool-specs.ts";
import { humanize } from "./tool-names.ts";

/*
 * ace's agent, thread, project and status tools as sentences: "Delegated “Review the login
 * flow”", "Notified you". Keyed by bare tool name (`delegate`, `thread_control`); providers'
 * spellings are stripped before lookup. Computer use, the browser and devices are in
 * `ace-tool-specs.ts`. Pure.
 */

type Family = AceToolSpec["family"];
type Args = Record<string, unknown>;
const spec = (family: Family, words: AceToolSpec["words"]): AceToolSpec => ({ family, words });
const fixed = (family: Family, words: ToolWords): AceToolSpec => spec(family, () => words);
const record = (value: unknown): Args =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Args) : {};

/** The first of `keys` that is a non-empty string, on one line and short. */
function named(args: Args, keys: readonly string[], max = 56) {
  for (const key of keys) {
    const value = str(args, key);
    if (value) {
      const line = value.split("\n")[0]!.trim();
      return line.length > max ? `${line.slice(0, max - 1)}…` : line;
    }
  }
  return undefined;
}

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function prLabel(args: Args): string {
  const number =
    typeof args.number === "number"
      ? args.number
      : typeof args.url === "string"
        ? /\/pull\/(\d+)/.exec(args.url)?.[1]
        : undefined;
  return number ? ` PR #${number}` : " a PR";
}

/* ---------------------------------------------------------------------------------------- */
/* Agents                                                                                    */

const delegated = ["Delegated", "Delegating", "Delegate"] as const;

/** One task reads as its words (and machine); several as a count. */
function delegateWords(args: Args): ToolWords {
  const tasks = Array.isArray(args.tasks) ? args.tasks.map(record) : [];
  if (tasks.length > 1) return say(delegated, ` ${tasks.length} tasks`);
  const [only] = tasks;
  const task = only && str(only, "task");
  const machine = only && str(only, "machine");
  return say(delegated, ` ${task ? quote(task, 56) : "a task"}${machine ? ` on ${machine}` : ""}`);
}

const deliveries: Record<string, readonly [string, string, string]> = {
  queue: ["Messaged a subagent", "Messaging a subagent", "Message a subagent"],
  steer: ["Steered a subagent", "Steering a subagent", "Steer a subagent"],
  restart: ["Restarted a subagent", "Restarting a subagent", "Restart a subagent"],
};

const agentSpecs: Record<string, AceToolSpec> = {
  delegate: spec("agents", ({ args }) => delegateWords(args)),
  wait: spec("agents", ({ args }) => {
    const n = count(args.threadIds);
    return say(verbs.waited, n ? ` ${plural(n, "agent")}` : " subagents");
  }),
  agents_status: spec("agents", ({ args }) =>
    say(verbs.checked, str(args, "threadId") ? " a subagent" : " subagents"),
  ),
  agent_message: spec("agents", ({ args }) =>
    say(
      deliveries[str(args, "delivery") ?? "queue"] ?? deliveries["queue"]!,
      "",
      named(args, ["text"]),
    ),
  ),
  agent_cancel: fixed("agents", say(["Stopped", "Stopping", "Stop"], " a subagent")),
  machines: fixed("device", say(verbs.listed, " your machines")),
  models: fixed("ace", say(verbs.listed, " models")),
};

/* ---------------------------------------------------------------------------------------- */
/* Threads                                                                                   */

/** `thread_control` reads by its action: "Renamed the thread to “X”", "Forked a thread". */
const controlWords: Record<string, (args: Args) => ToolWords> = {
  rename: (args) => {
    const title = named(args, ["title"]);
    return title
      ? say(["Renamed", "Renaming", "Rename"], ` the thread to ${quote(title)}`)
      : say(["Retitled", "Retitling", "Retitle"], " the thread");
  },
  configure: (args) => {
    const model = named(args, ["model"]);
    return say(["Switched", "Switching", "Switch"], " a thread's model", model);
  },
  fork: () => say(["Forked", "Forking", "Fork"], " a thread"),
  handoff: (args) =>
    say(["Handed off", "Handing off", "Hand off"], " the thread", named(args, ["branch"])),
  interrupt: () => say(["Stopped", "Stopping", "Stop"], " a thread"),
  settle: () => say(["Marked", "Marking", "Mark"], " a thread done"),
  snooze: (args) =>
    args.until === null
      ? say(["Unmuted", "Unmuting", "Unmute"], " a thread")
      : say(["Snoozed", "Snoozing", "Snooze"], " a thread"),
  close_preview: () => say(verbs.closed, " a preview"),
  rename_project: (args) => {
    const name = named(args, ["name"]);
    return say(
      ["Renamed", "Renaming", "Rename"],
      ` the project${name ? ` to ${quote(name)}` : ""}`,
    );
  },
};

const changedThread = say(["Changed", "Changing", "Change"], " a thread");

const threadSpecs: Record<string, AceToolSpec> = {
  threads_find: spec("threads", ({ args }) => {
    const query = str(args, "query");
    const where = str(args, "threadId") ? " a thread" : " threads";
    return query
      ? say(["Searched", "Searching", "Search"], `${where} for ${quote(query)}`)
      : say(verbs.listed, " recent threads");
  }),
  thread_read: spec("threads", ({ args }) =>
    str(args, "streamId")
      ? say(verbs.read, " a thread's output")
      : say(verbs.read, str(args, "threadId") ? " a thread" : " this thread"),
  ),
  thread_start: spec("threads", ({ args }) =>
    say(["Started a thread", "Starting a thread", "Start a thread"], "", named(args, ["title"])),
  ),
  thread_control: spec("threads", ({ args }) => {
    const words = controlWords[str(args, "action") ?? ""];
    return words ? words(args) : changedThread;
  }),
  thread_merge: fixed("threads", say(["Merged", "Merging", "Merge"], " a thread")),
  queue_edit: spec("threads", ({ args }) =>
    Array.isArray(args.order)
      ? say(["Reordered", "Reordering", "Reorder"], " the queue")
      : say(["Edited", "Editing", "Edit"], " a queued message"),
  ),
  question_answer: spec("threads", ({ args }) =>
    args.dismissed === true
      ? say(["Declined", "Declining", "Decline"], " a question")
      : say(["Answered", "Answering", "Answer"], " a question"),
  ),
  thread_link_pr: spec("threads", ({ args }) =>
    args.unlink === true
      ? say(["Unlinked", "Unlinking", "Unlink"], args.all === true ? " all PRs" : prLabel(args))
      : say(["Linked", "Linking", "Link"], prLabel(args)),
  ),
  handoff_read: fixed("threads", say(verbs.read, " the handoff history")),
};

/* ---------------------------------------------------------------------------------------- */
/* Project, automations and the person                                                       */

const contextTopics: Record<string, string> = {
  status: " ace's status",
  recent: " recent threads",
  changes: " this worktree's changes",
  prs: " linked PRs",
  notes: " project notes",
  diagnostics: " this session's diagnostics",
};

/** `offshift` reads by its action: "Recorded a passing check", "Moved the run to review". */
const offshiftWords: Record<string, (args: Args) => ToolWords> = {
  start: (args) =>
    say(
      ["Started an Offshift run", "Starting an Offshift run", "Start an Offshift run"],
      "",
      named(args, ["outcome", "runId"]),
    ),
  get: (args) => say(verbs.checked, " an Offshift run", named(args, ["runId"])),
  list: () => say(verbs.listed, " Offshift runs"),
  advance: (args) => {
    const phase = named(args, ["phase"]);
    return say(["Moved", "Moving", "Move"], ` an Offshift run${phase ? ` to ${phase}` : ""}`);
  },
  block: (args) => say(["Recorded", "Recording", "Record"], " a blocker", named(args, ["note"])),
  resume: (args) => say(["Cleared", "Clearing", "Clear"], " a blocker", named(args, ["note"])),
  evidence: (args) => {
    const evidence = record(args.evidence);
    const result = str(evidence, "result");
    const check =
      result === "fail" ? " a failing check" : result === "pass" ? " a passing check" : " a check";
    return say(["Recorded", "Recording", "Record"], check, named(evidence, ["criterionId"]));
  },
  revise: (args) =>
    say(["Revised", "Revising", "Revise"], " a criterion", named(record(args.criterion), ["id"])),
};

const projectSpecs: Record<string, AceToolSpec> = {
  context: spec("ace", ({ args }) => {
    const topics = Array.isArray(args.topics) ? args.topics : [];
    const [only] = topics;
    const topic = topics.length === 1 && typeof only === "string" ? contextTopics[only] : undefined;
    return say(verbs.checked, topic ?? " the project context");
  }),
  guide: spec("ace", ({ args }) => say(verbs.read, " the guide", named(args, ["topic"]))),
  tools_find: spec("ace", () => say(verbs.lookedFor, " ace tools")),
  automations_list: spec("ace", ({ args }) =>
    say(verbs.listed, args.runs === true ? " automation runs" : " automations"),
  ),
  automation_put: spec("ace", ({ args }) =>
    say(
      ["Saved an automation", "Saving an automation", "Save an automation"],
      "",
      named(args, ["title", "id"]),
    ),
  ),
  automation_run: spec("ace", ({ args }) =>
    say(
      ["Ran an automation", "Running an automation", "Run an automation"],
      "",
      named(args, ["id"]),
    ),
  ),
  automation_remove: spec("ace", ({ args }) =>
    say(
      ["Removed an automation", "Removing an automation", "Remove an automation"],
      "",
      named(args, ["id"]),
    ),
  ),
  note_add: spec("ace", ({ args }) => {
    const text = named(args, ["text"], 80);
    return say(
      ["Saved a project note", "Saving a project note", "Save a project note"],
      text ? `: ${quote(text, 80)}` : "",
    );
  }),
  offshift: spec("ace", ({ args }) => {
    const words = offshiftWords[str(args, "action") ?? ""];
    return words ? words(args) : say(["Updated", "Updating", "Update"], " an Offshift run");
  }),
  note_retire: fixed("ace", say(["Retired", "Retiring", "Retire"], " a project note")),
  ask: spec("ace", ({ args }) => {
    const question = named(args, ["question"], 80);
    return say(["Asked you", "Asking you", "Ask you"], question ? `: ${quote(question, 80)}` : "");
  }),
  notify: spec("ace", ({ args }) => {
    const text = named(args, ["text"], 80);
    return say(["Notified you", "Notifying you", "Notify you"], text ? `: ${quote(text, 80)}` : "");
  }),
  // Its markup and title are private input, redacted before they reach the transcript.
  html_render: fixed("ace", say(["Rendered", "Rendering", "Render"], " a page")),
  // Its bytes, alt and caption are redacted too; the posted image item shows them.
  image_show: fixed("ace", say(["Showed", "Showing", "Show"], " an image")),
};

const aceSpecs: Readonly<Record<string, AceToolSpec>> = {
  ...agentSpecs,
  ...threadSpecs,
  ...projectSpecs,
};

/** Any other ace tool, named by its words: "Used ace › frobnicate". */
export function unknownAceTool(name: string): AceToolSpec {
  return fixed("ace", say(["Used ace", "Using ace", "Use ace"], "", humanize(name)));
}

export { aceSpecs };
