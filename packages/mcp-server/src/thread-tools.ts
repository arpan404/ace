import { z } from "zod";
import {
  AccessRequest,
  AgentWorkspace,
  InteractionId,
  MessageText,
  ProviderKind,
  ThreadId,
} from "@ace/protocol";
import {
  NoData,
  controlResult,
  controlTool,
  controlToolTimeoutMs,
  fields,
  type Control,
} from "./control-tool.ts";
import { agentThreadPage } from "./thread-view.ts";

const threads = { toolset: "ace-threads", timeoutMs: controlToolTimeoutMs } as const;
const ownedThread = ThreadId.describe(
  "A thread you own: this one or one you started. With full access, also any of the person's threads.",
);

const SearchPage = z.looseObject({
  hits: z.array(
    z.looseObject({
      threadId: z.string(),
      threadTitle: z.string().optional(),
      itemId: z.string().optional(),
      snippet: z.looseObject({ text: z.string() }).optional(),
    }),
  ),
  cursor: z.string().nullable().optional(),
});
const threadsFind = controlTool({
  ...threads,
  name: "threads_find",
  title: "Find threads",
  riskClass: "read-only",
  capability: null,
  description:
    "Find threads in this project or, with full access, another one (project), or search inside one. Without threadId: threads whose title or messages match query (all recent threads when query is empty). With threadId: matching items in that thread's transcript. Page with cursor.",
  input: z
    .strictObject({
      query: z
        .string()
        .max(256)
        .default("")
        .describe("Words to match; empty lists recent threads."),
      threadId: ThreadId.optional().describe("Search inside this thread's transcript instead."),
      project: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          "Another project's name, folder path or id, from projects_find. Default: this one.",
        ),
      cursor: z.string().min(1).max(2048).optional().describe("From the previous page's cursor."),
      limit: z.number().int().min(1).max(20).default(10).describe("Results per page, 1 to 20."),
    })
    .refine((input) => !input.threadId || input.query.length > 0, {
      message: "Searching inside a thread needs a query.",
      path: ["query"],
    })
    .meta({ "x-ace-constraint": "With threadId, query must not be empty." }),
  output: controlResult(SearchPage),
  run: ({ query, threadId, project, cursor, limit }, control) =>
    control.run(
      threadId
        ? { op: "thread.search", threadId, query, limit, ...(cursor ? { cursor } : {}) }
        : {
            op: "threads.list",
            query,
            limit,
            ...(project ? { project } : {}),
            ...(cursor ? { cursor } : {}),
          },
    ),
});

const ThreadPage = z.looseObject({
  thread: z.looseObject({ id: z.string(), title: z.string() }).optional(),
  items: z.array(z.looseObject({ type: z.string(), id: z.string().optional() })).optional(),
  itemsBefore: z
    .number()
    .nullable()
    .optional()
    .describe("Pass as before for the previous page; null when nothing is earlier."),
  omitted: z
    .array(z.looseObject({ itemId: z.string(), dropped: z.string() }))
    .optional()
    .describe(
      "Items too large for a page: shown without raw payloads (dropped raw) or only summarized (dropped item).",
    ),
  linkedPrs: z.array(z.unknown()).optional(),
  previews: z.array(z.unknown()).optional(),
  text: z.string().optional().describe("With streamId: this page of the part's text, decoded."),
  nextOffset: z
    .number()
    .optional()
    .describe("With streamId: pass back unchanged as offset for the next page."),
  eof: z.boolean().optional().describe("With streamId: true when the text ends with this page."),
  queue: z.unknown().optional().describe("Messages waiting for the thread, oldest first."),
});
const threadRead = controlTool({
  ...threads,
  name: "thread_read",
  title: "Read a thread",
  riskClass: "read-only",
  capability: null,
  description:
    "Read a thread: title, status, branch, linked PRs, preview servers, queued messages (with entryIds for queue_edit) and a page of its latest transcript items, oldest first. Omit threadId for this thread. Page back with before = itemsBefore until it is null; an item too large for a page is listed in omitted. A truncated part with source.streamId continues as plain text: pass streamId with offset 0, then each page's nextOffset unchanged, until eof.",
  input: z.strictObject({
    threadId: ThreadId.optional().describe("Default: this thread."),
    before: z.number().int().positive().optional().describe("The previous page's itemsBefore."),
    limit: z.number().int().min(1).max(50).default(10).describe("Items per page, 1 to 50."),
    streamId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Read a truncated part's retained output instead of the transcript."),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0)
      .describe("With streamId: 0 to start, then the previous page's nextOffset, unchanged."),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(16_384)
      .default(8192)
      .describe(
        "With streamId: page size, up to 16384 (about 8,000 characters of message text). Pages end on whole characters.",
      ),
  }),
  output: controlResult(ThreadPage),
  async run(input, control) {
    const threadId = input.threadId ?? control.context.caller.threadId;
    if (input.streamId)
      return control.run({
        op: "thread.read_output",
        threadId,
        streamId: input.streamId,
        offset: input.offset,
        limit: input.maxBytes,
      });
    const page = await control.run({
      op: "thread.read",
      threadId,
      limit: input.limit,
      ...(input.before ? { before: input.before } : {}),
    });
    if (!page.ok) return page;
    return {
      ...page,
      data: {
        ...compactPage(page.data),
        ...(await previews(control, threadId)),
        ...(await queued(control, threadId)),
      },
    };
  },
});

/**
 * A thread's identifying fields and lean items; the full records carry client state and native
 * payloads an agent never reads.
 */
function compactPage(data: unknown): Record<string, unknown> {
  const page = agentThreadPage(z.record(z.string(), z.unknown()).safeParse(data).data ?? {});
  const thread = z.record(z.string(), z.unknown()).safeParse(page["thread"]).data;
  if (!thread) return page;
  const keep = ["id", "title", "titleSource", "provider", "workspaceId", "status", "permission"];
  const details = z.record(z.string(), z.unknown()).safeParse(thread["details"]).data;
  return {
    ...page,
    thread: {
      ...Object.fromEntries(keep.flatMap((key) => (key in thread ? [[key, thread[key]]] : []))),
      ...(typeof details?.["branch"] === "string" ? { branch: details["branch"] } : {}),
    },
  };
}
/** The thread's queue, only when something waits in it. */
async function queued(control: Control, threadId: string) {
  const listed = await control.run({ op: "queue.list", threadId });
  const entries = z.object({ entries: z.array(z.unknown()) }).safeParse(listed.data).data;
  return entries?.entries.length ? { queue: listed.data } : {};
}
async function previews(control: Control, threadId: string) {
  const listed = await control.run({ op: "preview.list", threadId });
  return Array.isArray(listed.data) && listed.data.length ? { previews: listed.data } : {};
}

const threadStart = controlTool({
  ...threads,
  name: "thread_start",
  title: "Start a top-level thread",
  riskClass: "agent-execution",
  capability: "thread_control",
  description:
    "Open a new top-level thread in the person's sidebar, in this project or another one on this machine (project); text is its first message and its agent answers at once. Use it when the person asks for a separate or dedicated thread. For child work whose result you need, use delegate. If the call is cut short, call again with the same requestId to get the same thread. The person sees it as a card: relay its summary in a sentence, without ids.",
  input: z.strictObject({
    requestId: fields.requestId,
    title: z.string().min(1).max(256).describe("The sidebar title."),
    text: MessageText.describe("The first message, standing on its own."),
    project: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        "Another project on this machine: its name, folder path or id from projects_find. Default: this project.",
      ),
    workspace: AgentWorkspace.default({ kind: "project" }).describe(
      "Where it works. Default: the project's checkout; new_worktree starts a Git worktree from base.",
    ),
    provider: ProviderKind.optional().describe("Default: yours."),
    model: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe('A model id from `models`, or its name as written ("opus 5.5").'),
    effort: z.string().min(1).max(64).optional().describe("Reasoning effort, such as high."),
    access: AccessRequest.optional().describe("Default inherit; never broader than yours."),
  }),
  output: controlResult(z.unknown()),
  run: (input, control) =>
    input.project && !control.context.capabilities.includes("projects")
      ? Promise.resolve({
          ok: false,
          code: "forbidden" as const,
          hint: "Other projects are off for this thread; start it in this project.",
        })
      : control.run({ op: "thread.start", ...input }),
});

const ProjectList = z.looseObject({
  projects: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      path: z.string(),
      current: z.boolean().optional(),
    }),
  ),
});
const projectsFind = controlTool({
  ...threads,
  name: "projects_find",
  title: "Find projects",
  riskClass: "read-only",
  capability: null,
  description:
    "List the projects open in ace on this machine, most recent first, or find one by words in its name or folder. current marks this thread's project. Pass a project's name or id to thread_start to open a thread there.",
  input: z.strictObject({
    query: z
      .string()
      .max(256)
      .default("")
      .describe("Words to match in the name or folder; empty lists recent projects."),
    limit: z.number().int().min(1).max(50).default(20).describe("Results, 1 to 50."),
  }),
  output: controlResult(ProjectList),
  run: ({ query, limit }, control) => control.run({ op: "projects.list", query, limit }),
});

const threadFork = controlTool({
  ...threads,
  name: "thread_fork",
  title: "Fork a thread",
  riskClass: "agent-execution",
  capability: "thread_control",
  description:
    "Fork a thread into a new one that keeps its conversation and takes it another way: text is the fork's first message (what to try instead), optionally on another model. It forks after the latest finished turn, so you can fork this thread mid-turn; runId picks an earlier turn. The fork shares the thread's checkout and is yours to message, settle and merge back with thread_merge. The person sees it as a card: relay it in a sentence, without ids.",
  input: z.strictObject({
    threadId: ownedThread.optional().describe("The thread to fork. Default: this thread."),
    requestId: fields.requestId,
    text: MessageText.describe(
      "The fork's first message: the other approach, standing on its own.",
    ),
    title: z.string().min(1).max(256).optional().describe("Its sidebar title."),
    runId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Fork after this finished run. Default: the latest finished one."),
    model: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        'Another model of the same provider and account: an id from `models` or its name ("opus 5.5"). Default: the thread\'s.',
      ),
    effort: z.string().min(1).max(64).optional().describe("Reasoning effort, with model."),
  }),
  output: controlResult(z.unknown()),
  run: ({ threadId, ...input }, control) =>
    control.run({
      op: "thread.fork",
      threadId: threadId ?? control.context.caller.threadId,
      ...input,
    }),
});

const threadMerge = controlTool({
  ...threads,
  name: "thread_merge",
  title: "Merge a fork back",
  riskClass: "thread-write",
  capability: "thread_control",
  description:
    "Bring a finished fork's result back into the thread it was forked from: summary says what the fork found or did, and it cites the fork's latest answer (or itemIds you pass). That thread's agent sees it from its next turn. A fork shares its source's checkout, so its file changes are already there. Wait for the fork to finish first.",
  input: z.strictObject({
    threadId: ownedThread.describe("The fork, from thread_fork."),
    requestId: fields.requestId,
    summary: MessageText.describe(
      "What the fork found or did, standing on its own for the other thread's agent.",
    ),
    itemIds: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Fork transcript items the summary rests on, from thread_read. Default: its latest answer.",
      ),
  }),
  output: controlResult(z.unknown()),
  run: (input, control) => control.run({ op: "thread.merge", ...input }),
});

/** Each action's required fields, named in its description and checked before anything runs. */
const queueNeeds = {
  edit: ["entryId", "text"],
  cancel: ["entryId"],
  steer: ["entryId"],
  reorder: ["order"],
} as const;
type QueueAction = keyof typeof queueNeeds;
const queueEdit = controlTool({
  ...threads,
  name: "queue_edit",
  title: "Edit queued messages",
  riskClass: "thread-write",
  capability: "thread_control",
  description:
    "Change an owned thread's queued messages before they are delivered; thread_read lists them with their entryIds. edit replaces an entry's text (attachments stay), cancel removes it, steer delivers it now into the running turn, reorder puts the named entries first in that order.",
  input: z
    .strictObject({
      threadId: ownedThread,
      requestId: fields.requestId,
      action: z
        .enum(["edit", "cancel", "steer", "reorder"])
        .describe("edit: entryId and text. cancel, steer: entryId. reorder: order."),
      entryId: z.string().min(1).max(128).optional().describe("The queued entry."),
      text: MessageText.optional().describe("edit: its new text."),
      order: z
        .array(z.string().min(1).max(128))
        .min(1)
        .max(64)
        .optional()
        .describe("reorder: entry ids in their new order."),
    })
    .superRefine((input, context) => {
      for (const field of queueNeeds[input.action])
        if (input[field] === undefined)
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${input.action} needs ${field}.`,
          });
    })
    .meta({
      "x-ace-constraint":
        "edit needs entryId and text; cancel and steer need entryId; reorder needs order.",
    }),
  output: NoData,
  run: (input, control) => control.run(queueOperation(input)),
});

/** The one operation a queue action stands for. Required fields were checked by the schema. */
function queueOperation(input: {
  threadId: string;
  requestId: string;
  action: QueueAction;
  entryId?: string | undefined;
  text?: string | undefined;
  order?: string[] | undefined;
}) {
  const { threadId, requestId } = input;
  const entryId = input.entryId ?? "";
  switch (input.action) {
    case "edit":
      return { op: "queue.edit", threadId, requestId, entryId, text: input.text ?? "" } as const;
    case "cancel":
      return { op: "queue.cancel", threadId, requestId, entryId } as const;
    case "steer":
      return { op: "queue.steer", threadId, requestId, entryId } as const;
    case "reorder":
      return { op: "queue.reorder", threadId, requestId, entryIds: input.order ?? [] } as const;
  }
}

const questionAnswer = controlTool({
  ...threads,
  name: "question_answer",
  title: "Answer an owned thread's question",
  riskClass: "thread-write",
  capability: "thread_control",
  description:
    "Answer a question an owned thread's agent asked (wait and agents_status name it under needs_you). Permission approvals belong to the person and cannot be answered here.",
  input: z.strictObject({
    threadId: ownedThread,
    requestId: fields.requestId,
    interactionId: InteractionId.describe("The request's interactionId."),
    answers: z
      .record(z.string(), z.array(z.string()))
      .describe("Question id to the chosen option ids, or to free text when other is allowed."),
    dismissed: z.boolean().optional().describe("Decline to answer; the agent continues without."),
    feedback: z.string().max(8192).optional().describe("Why, when declining."),
  }),
  output: NoData,
  run: ({ threadId, requestId, interactionId, answers, dismissed, feedback }, control) =>
    control.run({
      op: "question.answer",
      threadId,
      requestId,
      interactionId,
      answer: {
        kind: "question",
        answers,
        ...(dismissed === undefined ? {} : { dismissed }),
        ...(feedback === undefined ? {} : { feedback }),
      },
    }),
});

const threadLinkPr = controlTool({
  ...threads,
  name: "thread_link_pr",
  title: "Link a pull request",
  riskClass: "thread-write",
  capability: "thread_control",
  description:
    "Link the pull request for this thread's work, by URL or number, so the person sees its state and CI on the thread. Call it right after you open or find the PR. unlink removes a link (all: true removes every link); the PR itself never changes.",
  input: z
    .strictObject({
      url: z.url().max(2048).optional().describe("The pull request URL."),
      number: z.number().int().positive().optional().describe("Or its number."),
      repo: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe("owner/name or host/owner/name; default: this workspace's origin."),
      unlink: z.boolean().default(false).describe("Remove the link instead."),
      all: z.literal(true).optional().describe("With unlink: remove every link."),
    })
    .refine(
      (input) =>
        [input.url, input.number, input.all].filter((value) => value !== undefined).length === 1 &&
        (input.all === undefined || input.unlink),
      { message: "Pass url or number (or unlink with all: true)." },
    )
    .meta({
      "x-ace-constraint": "Exactly one of url, number, or all: true; all only with unlink.",
    }),
  output: controlResult(z.unknown()),
  run: ({ url, number, repo, unlink, all }, control) =>
    control.run(
      unlink
        ? {
            op: "thread.unlink_pr",
            ...(url ? { url } : {}),
            ...(number ? { number } : {}),
            ...(all ? { all } : {}),
          }
        : {
            op: "thread.link_pr",
            ...(url ? { url } : {}),
            ...(number ? { number } : {}),
            ...(repo ? { repo } : {}),
          },
    ),
});

export const threadTools = [
  threadsFind,
  projectsFind,
  threadRead,
  threadStart,
  threadFork,
  threadMerge,
  queueEdit,
  questionAnswer,
  threadLinkPr,
];
