import { say, str, quote, verbs, type AceToolSpec, type ToolWords } from "./ace-tool-specs.ts";
import { humanize } from "./tool-names.ts";

/*
 * ace's agent, thread, project and status tools as sentences: "Delegated “Review the login
 * flow”", "Notified you". Computer use, the browser and devices are in `ace-tool-specs.ts`.
 * Pure.
 */

type Family = AceToolSpec["family"];
const spec = (family: Family, words: AceToolSpec["words"]): AceToolSpec => ({ family, words });
const fixed = (family: Family, words: ToolWords): AceToolSpec => spec(family, () => words);

/** The first of `keys` that is a non-empty string, on one line and short. */
function named(args: Record<string, unknown>, keys: readonly string[], max = 56) {
  for (const key of keys) {
    const value = str(args, key);
    if (value) {
      const line = value.split("\n")[0]!.trim();
      return line.length > max ? `${line.slice(0, max - 1)}…` : line;
    }
  }
  return undefined;
}

const threadRead = spec("threads", ({ args }) =>
  say(verbs.read, " thread", named(args, ["title", "threadId"])),
);

function prLabel(args: Record<string, unknown>): string {
  const number =
    typeof args.number === "number"
      ? args.number
      : typeof args.url === "string"
        ? /\/pull\/(\d+)/.exec(args.url)?.[1]
        : undefined;
  return number ? ` PR #${number}` : " a PR";
}

const aceSpecs: Record<string, AceToolSpec> = {
  ace_device_list: fixed("device", say(verbs.listed, " connected devices")),
  ace_device_delegate: fixed(
    "device",
    say(["Delegated", "Delegating", "Delegate"], " work to another device"),
  ),
  ace_device_task_publish: fixed(
    "device",
    say(["Returned", "Returning", "Return"], " results from another device"),
  ),
  ace_device_task_status: fixed(
    "device",
    say(["Checked", "Checking", "Check"], " work on another device"),
  ),
  ace_device_task_wait: fixed("device", say(verbs.waited, " work on another device")),
  ace_device_task_cancel: fixed(
    "device",
    say(["Stopped", "Stopping", "Stop"], " work on another device"),
  ),
  delegate_task: spec("agents", ({ args }) => {
    const task = str(args, "task");
    return say(["Delegated", "Delegating", "Delegate"], ` ${task ? quote(task, 56) : "a task"}`);
  }),
  ace_spawn_agent: spec("agents", ({ args }) =>
    say(
      ["Started a subagent", "Starting a subagent", "Start a subagent"],
      "",
      named(args, ["name", "role", "title"]),
    ),
  ),
  ace_list_agents: fixed("agents", say(verbs.listed, " agents")),
  ace_wait: fixed("agents", say(verbs.waited, " subagents")),
  ace_thread_info: fixed("threads", say(verbs.read, " this thread's details")),
  ace_thread_read: threadRead,
  ace_thread_read_output: threadRead,
  ace_thread_search: spec("threads", ({ args }) => {
    const query = str(args, "query");
    return say(
      ["Searched", "Searching", "Search"],
      ` threads${query ? ` for ${quote(query)}` : ""}`,
    );
  }),
  ace_thread_create: spec("threads", ({ args }) =>
    say(
      ["Created a thread", "Creating a thread", "Create a thread"],
      "",
      named(args, ["title", "name"]),
    ),
  ),
  ace_thread_launch: fixed("threads", say(verbs.started, " a thread")),
  ace_thread_message: spec("threads", ({ args }) =>
    say(
      ["Messaged a thread", "Messaging a thread", "Message a thread"],
      "",
      named(args, ["text", "message"]),
    ),
  ),
  ace_thread_wait: fixed("threads", say(verbs.waited, " a thread")),
  ace_thread_interrupt: spec("threads", ({ args }) =>
    say(["Stopped a thread", "Stopping a thread", "Stop a thread"], "", named(args, ["threadId"])),
  ),
  ace_thread_fork: fixed("threads", say(["Forked", "Forking", "Fork"], " a thread")),
  ace_thread_merge: fixed("threads", say(["Merged", "Merging", "Merge"], " a thread")),
  ace_thread_rename: spec("threads", ({ args }) => {
    const title = named(args, ["title"]);
    return say(
      ["Renamed", "Renaming", "Rename"],
      ` the thread${title ? ` to ${quote(title)}` : ""}`,
    );
  }),
  ace_thread_regenerate_title: fixed(
    "threads",
    say(["Retitled", "Retitling", "Retitle"], " the thread"),
  ),
  ace_thread_link_pr: spec("threads", ({ args }) =>
    say(["Linked", "Linking", "Link"], prLabel(args)),
  ),
  ace_thread_unlink_pr: spec("threads", ({ args }) =>
    say(["Unlinked", "Unlinking", "Unlink"], args.all === true ? " all PRs" : prLabel(args)),
  ),
  ace_thread_list_prs: fixed("threads", say(["Listed", "Listing", "List"], " linked PRs")),
  ace_thread_settle: fixed("threads", say(["Marked", "Marking", "Mark"], " a thread done")),
  ace_thread_snooze: fixed("threads", say(["Snoozed", "Snoozing", "Snooze"], " a thread")),
  ace_thread_handoff: fixed(
    "threads",
    say(["Handed off", "Handing off", "Hand off"], " the thread"),
  ),
  ace_queue_edit: fixed("threads", say(["Edited", "Editing", "Edit"], " a queued message")),
  ace_queue_reorder: fixed("threads", say(["Reordered", "Reordering", "Reorder"], " the queue")),
  ace_question_answer: fixed("threads", say(["Answered", "Answering", "Answer"], " a question")),
  ace_read_handoff: fixed("threads", say(verbs.read, " the handoff history")),
  ace_read_handoff_chunk: fixed("threads", say(verbs.read, " the handoff history")),
  ace_notify_user: spec("ace", ({ args }) => {
    const text = named(args, ["text", "title", "message"], 80);
    return say(["Notified you", "Notifying you", "Notify you"], text ? `: ${quote(text, 80)}` : "");
  }),
  ace_project_read: spec("ace", ({ args }) => say(verbs.read, " project", named(args, ["path"]))),
  ace_project_rename: fixed("ace", say(["Renamed", "Renaming", "Rename"], " the project")),
  ace_preview_list: fixed("ace", say(verbs.listed, " previews")),
  ace_preview_close: fixed("ace", say(verbs.closed, " a preview")),
  ace_automation_manage: spec("ace", ({ args }) =>
    say(
      ["Updated an automation", "Updating an automation", "Update an automation"],
      "",
      named(args, ["name", "title"]),
    ),
  ),
  ace_status: fixed("ace", say(verbs.checked, " ace's status")),
  ace_context_usage: fixed("ace", say(verbs.checked, " context use")),
  ace_models: fixed("ace", say(verbs.listed, " models")),
};

/** Any other `ace_*` tool, named by its words: "Used ace › frobnicate". */
export function unknownAceTool(name: string): AceToolSpec {
  return fixed(
    "ace",
    say(["Used ace", "Using ace", "Use ace"], "", humanize(name.replace(/^ace_/, ""))),
  );
}

export { aceSpecs };
