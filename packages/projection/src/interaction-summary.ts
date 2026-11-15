import type {
  ApprovalOption,
  ApprovalTarget,
  Interaction,
  InteractionRequest,
  InteractionResolution,
  Question,
  TodoEntry,
} from "@ace/protocol";

/*
 * How a request too large to send with its thread goes to clients (ADR 0157): as a summary that
 * says it is one (`truncated`), never cut silently. A summary keeps what identifies the request
 * and every option and id an answer names, cuts each text to a few KiB and leaves out what has no
 * bound of its own (a tool's input, an elicitation's schema, raw payloads), so it stays small
 * however large the request. The whole request is read with `interaction.read`, and an
 * affirmative answer is refused until the person was shown it.
 */

/** Requests whose JSON is longer than this (UTF-16 code units) go to clients summarized. */
export const wholeRequestChars = 64 * 1024;

const textChars = 2048;
const titleChars = 1024;
const labelChars = 256;
const markdownChars = 4096;
const mostOptions = 32;
/** Declines past `mostOptions` still go, up to this many options in all. */
const mostWithDeclines = 64;
const mostQuestions = 8;
const mostAnswers = 12;
const answerChars = 128;
const mostPaths = 8;
const mostTodos = 32;
const longestUrl = 8192;
const longestId = 1024;

/** The length `truncated.chars` counts: the request's JSON in UTF-16 code units. */
export function requestChars(request: InteractionRequest): number {
  return JSON.stringify(request).length;
}

/** Whether a client gets `interaction` summarized rather than whole. */
export function sentSummarized(interaction: Pick<Interaction, "request" | "truncated">): boolean {
  return (
    interaction.truncated !== undefined || requestChars(interaction.request) > wholeRequestChars
  );
}

/**
 * `interaction` as clients get it: itself when its request is within `wholeRequestChars` (or it
 * is a summary already), else its summary.
 */
export function summarizeInteraction(interaction: Interaction): Interaction {
  if (interaction.truncated !== undefined) return interaction;
  const chars = requestChars(interaction.request);
  if (chars <= wholeRequestChars) return interaction;
  return {
    ...interaction,
    request: summarizeRequest(interaction.request),
    raw: [],
    truncated: { chars },
  };
}

/** Whether `resolution` says yes: allows, approves, accepts or answers. */
export function affirms(request: InteractionRequest, resolution: InteractionResolution): boolean {
  switch (resolution.kind) {
    case "approval": {
      const option =
        request.kind === "approval"
          ? request.options.find((candidate) => candidate.id === resolution.optionId)
          : undefined;
      // An option the request doesn't list is no decline.
      return option === undefined || option.kind.startsWith("allow");
    }
    case "question":
      return resolution.dismissed !== true;
    case "plan_review":
      return resolution.decision === "approve";
    case "elicitation":
      return resolution.action === "accept";
    case "browser_help":
      return false;
  }
}

/**
 * Why a client's answer is refused, if it is: an affirmative answer to a request clients get
 * summarized needs the person to have been shown it whole (`readWhole`). A copy that is itself
 * a summary (another machine's request, mirrored) cannot be shown whole here, so only a decline
 * goes.
 */
export function answerRefusal(
  interaction: Interaction,
  resolution: InteractionResolution,
  readWhole: boolean,
): "request_not_read" | undefined {
  if (!affirms(interaction.request, resolution)) return undefined;
  if (interaction.truncated !== undefined) return "request_not_read";
  if (readWhole) return undefined;
  return requestChars(interaction.request) > wholeRequestChars ? "request_not_read" : undefined;
}

function summarizeRequest(request: InteractionRequest): InteractionRequest {
  switch (request.kind) {
    case "approval":
      return {
        kind: "approval",
        title: cut(request.title, titleChars),
        ...some(request.description, textChars, (description) => ({ description })),
        ...(request.target ? { target: summarizeTarget(request.target) } : {}),
        options: keptOptions(request.options.filter(named)).map(cutOption),
        ...(request.defaultToNo === undefined ? {} : { defaultToNo: request.defaultToNo }),
        ...(request.suppressAlwaysAllowRule === undefined
          ? {}
          : { suppressAlwaysAllowRule: request.suppressAlwaysAllowRule }),
        ...(request.mcpServer
          ? {
              mcpServer: {
                name: cut(request.mcpServer.name, labelChars),
                source: cut(request.mcpServer.source, labelChars),
              },
            }
          : {}),
      };
    case "question":
      return {
        kind: "question",
        questions: request.questions.filter(named).slice(0, mostQuestions).map(cutQuestion),
        ...(request.target ? { target: summarizeTarget(request.target) } : {}),
      };
    case "plan_review":
      return {
        kind: "plan_review",
        ...some(request.title, titleChars, (title) => ({ title })),
        ...some(request.summary, textChars, (summary) => ({ summary })),
        markdown: cut(request.markdown, markdownChars),
        ...some(request.planPath, titleChars, (planPath) => ({ planPath })),
        ...(request.todos
          ? {
              todos: request.todos.slice(0, mostTodos).map(cutTodo),
            }
          : {}),
      };
    case "elicitation":
      return {
        kind: "elicitation",
        server: cut(request.server, labelChars),
        message: cut(request.message, textChars),
        // A cut address leads somewhere else: one too long is left out.
        ...(request.url !== undefined && request.url.length <= longestUrl
          ? { url: request.url }
          : {}),
        ...(request.mode === undefined ? {} : { mode: request.mode }),
        ...(request.nativeId !== undefined && request.nativeId.length <= longestId
          ? { nativeId: request.nativeId }
          : {}),
        ...some(request.title, titleChars, (title) => ({ title })),
        ...some(request.description, textChars, (description) => ({ description })),
      };
    case "browser_help":
      // Bounded by its schema but for its target.
      return request.target ? { ...request, target: summarizeTarget(request.target) } : request;
  }
}

/**
 * Whether an id is short enough to keep. Ids are what an answer names, so they are never cut;
 * one longer than this is left out with what it names, which keeps a summary bounded.
 */
function named(entry: { id: string }): boolean {
  return entry.id.length <= longestId;
}

function cutOption(option: ApprovalOption): ApprovalOption {
  return { id: option.id, label: cut(option.label, labelChars), kind: option.kind };
}

function cutQuestion(question: Question): Question {
  const kept: Question = {
    id: question.id,
    text: cut(question.text, titleChars),
    options: question.options.filter(named).slice(0, mostAnswers).map(cutAnswer),
    multiSelect: question.multiSelect,
    allowOther: question.allowOther,
    secret: question.secret,
  };
  if (question.header !== undefined) kept.header = cut(question.header, labelChars);
  return kept;
}

function cutAnswer(option: Question["options"][number]): Question["options"][number] {
  const kept: Question["options"][number] = {
    id: option.id,
    label: cut(option.label, answerChars),
  };
  if (option.description !== undefined) kept.description = cut(option.description, answerChars);
  return kept;
}

function cutTodo(todo: TodoEntry): TodoEntry {
  const kept: TodoEntry = { content: cut(todo.content, labelChars), status: todo.status };
  if (todo.id !== undefined) kept.id = cut(todo.id, labelChars);
  return kept;
}

function summarizeTarget(target: ApprovalTarget): ApprovalTarget {
  return {
    tool: target.tool,
    ...(target.origin === undefined ? {} : { origin: target.origin }),
    ...(target.description === undefined ? {} : { description: target.description }),
    ...(target.riskClass === undefined ? {} : { riskClass: target.riskClass }),
    ...some(target.command, textChars, (command) => ({ command })),
    ...some(target.cwd, titleChars, (cwd) => ({ cwd })),
    ...(target.paths
      ? { paths: target.paths.slice(0, mostPaths).map((path) => cut(path, titleChars)) }
      : {}),
    access: target.access,
  };
}

/** The first `mostOptions` options, then any later declines, in order: a decline always goes. */
function keptOptions<O extends { kind: string }>(options: readonly O[]): O[] {
  const kept: O[] = [];
  for (const [index, option] of options.entries()) {
    if (kept.length >= mostWithDeclines) break;
    if (index < mostOptions || !option.kind.startsWith("allow")) kept.push(option);
  }
  return kept;
}

/** `put` of `text` cut to `most`, or nothing without it. */
function some<T>(text: string | undefined, most: number, put: (text: string) => T): T | object {
  return text === undefined ? {} : put(cut(text, most));
}

/** `text` within `most` code units, ending in "…" when cut, never splitting a surrogate pair. */
function cut(text: string, most: number): string {
  if (text.length <= most) return text;
  let end = most - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}
