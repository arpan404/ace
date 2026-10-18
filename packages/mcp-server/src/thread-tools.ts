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

const threads = { toolset: "ace-threads", timeoutMs: controlToolTimeoutMs } as const;
const ownedThread = ThreadId.describe("A thread you own: this one or one you started.");

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
    "Find threads in this project, or search inside one. Without threadId: threads whose title or messages match query (all recent threads when query is empty). With threadId: matching items in that thread's transcript. Page with cursor.",
  input: z
    .strictObject({
      query: z
        .string()
        .max(256)
        .default("")
        .describe("Words to match; empty lists recent threads."),
      threadId: ThreadId.optional().describe("Search inside this thread's transcript instead."),
      cursor: z.string().min(1).max(2048).optional().describe("From the previous page's cursor."),
      limit: z.number().int().min(1).max(20).default(10).describe("Results per page, 1 to 20."),
    })
    .refine((input) => !input.threadId || input.query.length > 0, {
      message: "Searching inside a thread needs a query.",
      path: ["query"],
    })
    .meta({ "x-ace-constraint": "With threadId, query must not be empty." }),
  output: controlResult(SearchPage),
  run: ({ query, threadId, cursor, limit }, control) =>
    control.run(
      threadId
        ? { op: "thread.search", threadId, query, limit, ...(cursor ? { cursor } : {}) }
        : { op: "threads.list", query, limit, ...(cursor ? { cursor } : {}) },
    ),
});

const ThreadPage = z.looseObject({
  thread: z.looseObject({ id: z.string(), title: z.string() }).optional(),
  items: z.array(z.looseObject({ type: z.string(), id: z.string().optional() })).optional(),
  itemsBefore: z.number().nullable().optional(),
  linkedPrs: z.array(z.unknown()).optional(),
  previews: z.array(z.unknown()).optional(),
  bytes: z.string().optional().describe("Base64 output bytes, when reading a stream"),
  nextOffset: z.number().optional(),
});
const threadRead = controlTool({
  ...threads,
  name: "thread_read",
  title: "Read a thread",
  riskClass: "read-only",
  capability: null,
  description:
    "Read a thread: title, status, branch, linked PRs, preview servers and a page of its transcript, newest first. Omit threadId for this thread. Page back with before = itemsBefore. A truncated part with source.streamId continues with streamId and offset (base64 bytes, then nextOffset).",
  input: z.strictObject({
    threadId: ThreadId.optional().describe("Default: this thread."),
    before: z.number().int().positive().optional().describe("The previous page's itemsBefore."),
    limit: z.number().int().min(1).max(50).default(20).describe("Items per page, 1 to 50."),
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
      .describe("With streamId: byte offset, from nextOffset."),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(16_384)
      .default(8192)
      .describe("With streamId: bytes to read, up to 16384."),
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
    return { ...page, data: { ...compactPage(page.data), ...(await previews(control, threadId)) } };
  },
});

/** A thread's identifying fields; the full record carries client state an agent never reads. */
function compactPage(data: unknown): Record<string, unknown> {
  const page = z.record(z.string(), z.unknown()).safeParse(data).data ?? {};
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
    "Open a new top-level thread in the person's sidebar; text is its first message and its agent answers at once. For child work whose result you need, use delegate. If the call is cut short, call again with the same requestId to get the same thread. The person sees it as a card: relay its summary in a sentence, without ids.",
  input: z.strictObject({
    requestId: fields.requestId,
    title: z.string().min(1).max(256).describe("The sidebar title."),
    text: MessageText.describe("The first message, standing on its own."),
    workspace: AgentWorkspace.default({ kind: "project" }).describe(
      "Where it works. Default: this project's checkout; new_worktree starts a Git worktree from base.",
    ),
    provider: ProviderKind.optional().describe("Default: yours."),
    model: z.string().min(1).max(256).optional().describe("A model id from `models`."),
    effort: z.string().min(1).max(64).optional().describe("Reasoning effort, such as high."),
    access: AccessRequest.optional().describe("Default inherit; never broader than yours."),
  }),
  output: controlResult(z.unknown()),
  run: (input, control) => control.run({ op: "thread.start", ...input }),
});

const threadMerge = controlTool({
  ...threads,
  name: "thread_merge",
  title: "Merge a thread's work",
  riskClass: "external-effect",
  openWorld: false,
  destructive: true,
  capability: "thread_control",
  description:
    "Merge an owned thread's worktree changes back into the branch it started from. This overwrites files there, so your provider may ask the person first.",
  input: z.strictObject({ threadId: ownedThread, requestId: fields.requestId }),
  output: controlResult(z.unknown()),
  run: (input, control) => control.run({ op: "thread.merge", ...input }),
});

const queueEdit = controlTool({
  ...threads,
  name: "queue_edit",
  title: "Edit queued messages",
  riskClass: "thread-write",
  capability: "thread_control",
  description:
    "Change an owned thread's queued input before it is delivered: replace one entry's text (entryId and text), or reorder pending entries (order).",
  input: z
    .strictObject({
      threadId: ownedThread,
      requestId: fields.requestId,
      entryId: z.string().min(1).max(128).optional().describe("The queued entry to replace."),
      text: MessageText.optional().describe("Its new text."),
      order: z
        .array(z.string().min(1).max(128))
        .min(1)
        .max(64)
        .optional()
        .describe("Pending entry ids in their new order."),
    })
    .refine(
      (input) =>
        (input.order === undefined) !== (input.entryId === undefined || input.text === undefined),
      { message: "Pass entryId with text, or order." },
    )
    .meta({ "x-ace-constraint": "Either entryId with text, or order." }),
  output: NoData,
  run: ({ threadId, requestId, entryId, text, order }, control) =>
    control.run(
      order
        ? { op: "queue.reorder", threadId, requestId, entryIds: order }
        : // The schema requires both when order is absent.
          { op: "queue.edit", threadId, requestId, entryId: entryId ?? "", text: text ?? "" },
    ),
});

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
  threadRead,
  threadStart,
  threadMerge,
  queueEdit,
  questionAnswer,
  threadLinkPr,
];
