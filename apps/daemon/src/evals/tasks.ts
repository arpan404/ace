import { z } from "zod";
import type { ThreadId } from "@ace/protocol";
import type { CallResult } from "./agent.ts";
import type { TaskMetrics } from "./trace.ts";
import { seededConsoleError, type EvalWorld } from "./world.ts";

export interface TaskOutcome {
  readonly metrics: TaskMetrics;
  /** One line on what the policy concluded, for the report. */
  readonly note: string;
}
export interface EvalTask {
  readonly id: string;
  readonly title: string;
  /** Correctness tasks are hard gates: a call-count win never excuses a failure here. */
  readonly gate: boolean;
  readonly needsBrowser?: boolean;
  run(world: EvalWorld): Promise<TaskOutcome>;
}

/**
 * Oracle policies: each follows the shortest correct path using only what a model could see
 * (instructions, the tool list and tool results). They measure what the surface makes possible.
 */
const Control = z.object({ ok: z.boolean(), code: z.string().optional(), data: z.unknown() });
export const control = (result: CallResult) => Control.safeParse(result.data);
export const record = (value: unknown) =>
  z.record(z.string(), z.unknown()).safeParse(value).data ?? undefined;

const whereAmI: EvalTask = {
  id: "where-am-i",
  title: "Find where I am: project, branch, access mode, live siblings",
  gate: false,
  async run(world) {
    await world.liveThread("Refactor the cart");
    const { agent, threadId } = await world.agent({});
    const thread = world.store.getThread(threadId);
    const truth = {
      project: "shop",
      branch: world.branch,
      access: thread?.permission?.effective ?? null,
      liveSiblings: liveOthers(world, threadId),
    };
    const seen: Record<string, unknown> = {};
    // With a session brief in the instructions, every fact is already known: no calls.
    const facts = readBrief(agent.instructions);
    if (facts) {
      const { delegates: _delegates, ...known } = facts;
      Object.assign(seen, known);
      const success = JSON.stringify(sorted(seen)) === JSON.stringify(sorted(truth));
      return {
        metrics: agent.finish(success),
        note: success
          ? "all facts from the brief"
          : `saw ${JSON.stringify(seen)}, truth ${JSON.stringify(truth)}`,
      };
    }
    // Without a brief, context's status and changes topics plus one thread search cover it.
    await agent.turn(async () => {
      const [known, list] = await Promise.all([
        agent.call("context", { topics: ["status", "changes"] }),
        agent.call("threads_find", {}),
      ]);
      const status = record(record(known.data)?.["status"]);
      seen["access"] = status?.["access"] ?? null;
      seen["project"] = record(status?.["project"])?.["name"];
      seen["branch"] = record(record(known.data)?.["changes"])?.["branch"] ?? null;
      seen["liveSiblings"] = countLive(control(list).data?.data, threadId);
    });
    // ace did not say which branch: the model asks git with its own shell.
    if (typeof seen["branch"] !== "string")
      seen["branch"] = await agent.turn(async () =>
        agent.ownTool("shell", { command: "git branch --show-current" }, world.branch),
      );
    const answer = seen;
    const success = JSON.stringify(sorted(answer)) === JSON.stringify(sorted(truth));
    return {
      metrics: agent.finish(success),
      note: success
        ? "all facts correct"
        : `saw ${JSON.stringify(answer)}, truth ${JSON.stringify(truth)}`,
    };
  },
};

const delegateTwo: EvalTask = {
  id: "delegate-two",
  title: "Delegate two tasks and collect both results",
  gate: false,
  async run(world) {
    const { agent } = await world.agent({});
    const listed = readBrief(agent.instructions)?.delegates.includes("claude");
    const provider = listed
      ? "claude"
      : await agent.turn(async () => {
          const catalog = control(await agent.call("models", {}));
          const providers = z
            .object({
              providers: z.array(z.object({ provider: z.string(), installed: z.boolean() })),
            })
            .safeParse(catalog.data?.data).data?.providers;
          return providers?.find((entry) => entry.installed && entry.provider === "claude")
            ?.provider;
        });
    if (!provider) return { metrics: agent.finish(false), note: "no provider found" };
    const tasks = [
      { requestId: "fix-header", task: "Fix the header spacing", answer: "Header spacing fixed" },
      { requestId: "fix-footer", task: "Fix the footer links", answer: "Footer links fixed" },
    ];
    // delegate's description: one call with waitSeconds starts both and returns results.
    const result = await agent.turn(async () => {
      const call = agent.call("delegate", {
        tasks: tasks.map((task) => ({
          requestId: task.requestId,
          task: task.task,
          role: `eval-${task.requestId}`,
          provider,
        })),
        waitSeconds: 120,
      });
      // The children finish while the parent waits.
      await world.answerChildren(new Map(tasks.map((task) => [task.task, task.answer])));
      return call;
    });
    const text = JSON.stringify(control(result).data?.data ?? "");
    const success = !result.failed && tasks.every((task) => text.includes(task.answer));
    return {
      metrics: agent.finish(success),
      note: success ? "both results collected" : clipNote(result.text),
    };
  },
};

const clipNote = (text: string) => text.replace(/\s+/g, " ").slice(0, 160);

const browserCheck: EvalTask = {
  id: "browser-check",
  title: "Open the dev server in the browser and report console and network errors",
  gate: false,
  needsBrowser: true,
  async run(world) {
    const { agent } = await world.agent({});
    await agent.turn(() => agent.call("ace_browser_open", { url: world.devServerUrl }));
    await agent.turn(() => agent.call("ace_browser_wait_for", { text: "Sign in" }));
    const logs = await agent.turn(() => agent.call("ace_browser_logs", {}));
    const consoleError = logs.text.includes(seededConsoleError);
    const failedRequest = /\b500\b/.test(logs.text);
    return {
      metrics: agent.finish(consoleError && failedRequest),
      note: `console error ${consoleError ? "found" : "missed"}, 500 ${failedRequest ? "found" : "missed"}`,
    };
  },
};

const recentWork: EvalTask = {
  id: "recent-work",
  title: "Read the project's recent work and its outcome",
  gate: false,
  async run(world) {
    const outcome =
      "Fixed the redirect loop in src/auth.ts; the session cookie is now SameSite=Lax";
    await world.finishedThread("Fix the login redirect loop", outcome);
    const { agent, threadId } = await world.agent({});
    // One read when ace offers project context.
    if (agent.has("context")) {
      const context = await agent.turn(() => agent.call("context", { topics: ["recent"] }));
      const success = context.text.includes(outcome);
      return { metrics: agent.finish(success), note: success ? "outcome found" : "outcome missed" };
    }
    const list = await agent.turn(() => agent.call("threads_find", {}));
    const other = threadEntries(control(list).data?.data).find((entry) => entry.id !== threadId);
    if (!other) return { metrics: agent.finish(false), note: "no earlier thread found" };
    const read = await agent.turn(() => agent.call("thread_read", { threadId: other.id }));
    const success = read.text.includes(outcome);
    return { metrics: agent.finish(success), note: success ? "outcome found" : "outcome missed" };
  },
};

const visualize: EvalTask = {
  id: "visualize",
  title: "Render a small comparison as HTML",
  gate: false,
  async run(world) {
    const { agent } = await world.agent({});
    const html = `<!doctype html><style>table{font:14px system-ui}</style><table><tr><th>Plan</th><th>Calls</th></tr><tr><td>Before</td><td>6</td></tr><tr><td>After</td><td>2</td></tr></table>`;
    const page = { title: "Calls per plan", html };
    const rendered = await agent.turn(() => agent.call("html_render", page));
    const itemId = record(rendered.data)?.["itemId"];
    return {
      metrics: agent.finish(!rendered.failed && typeof itemId === "string"),
      note: rendered.failed ? "render failed" : "rendered",
    };
  },
};

/**
 * One slipped argument per tool. Following P3's acceptance test, the repair may use only the
 * error payload: the issue paths. With no path, the only move left is a blind retry.
 */
const recoverBadArgument: EvalTask = {
  id: "recover-bad-argument",
  title: "Recover from a wrong argument using only the error",
  gate: false,
  async run(world) {
    const { agent, threadId } = await world.agent({});
    const cases: {
      tool: string;
      sent: Record<string, unknown>;
      intended: Record<string, unknown>;
    }[] = [
      {
        tool: "thread_control",
        sent: { action: "rename", threadId, titel: "Login page" },
        intended: { action: "rename", threadId, title: "Login page" },
      },
      {
        tool: "delegate",
        sent: {
          tasks: [{ requestId: "slip", task: "Add tests", role: "tester", provider: "gpt-5" }],
        },
        intended: {
          tasks: [{ requestId: "slip", task: "Add tests", role: "tester", provider: "claude" }],
        },
      },
      { tool: "threads_find", sent: { limit: 500 }, intended: { limit: 10 } },
      {
        tool: "threads_find",
        sent: { threadId, query: "" },
        intended: { threadId, query: "login" },
      },
      {
        tool: "html_render",
        sent: { title: "x", html: "<p>x</p>", mode: "fancy" },
        intended: { title: "x", html: "<p>x</p>", mode: "static" },
      },
      { tool: "notify", sent: { message: "done" }, intended: { text: "done" } },
    ];
    let recovered = 0;
    for (const entry of cases) {
      const first = await agent.turn(() => agent.call(entry.tool, entry.sent));
      if (!first.failed) continue;
      const repaired = repair(entry.sent, entry.intended, issuePaths(first.text));
      const second = await agent.turn(() => agent.call(entry.tool, repaired));
      if (!second.failed) recovered++;
    }
    return {
      metrics: agent.finish(recovered === cases.length),
      note: `${recovered}/${cases.length} recovered on the second call`,
    };
  },
};

const childWaitingOnHuman: EvalTask = {
  id: "child-waits-on-human",
  title: "A child waiting on the person is never reported done",
  gate: true,
  async run(world) {
    const { agent } = await world.agent({});
    const started = await agent.turn(() =>
      agent.call("delegate", {
        tasks: [
          {
            requestId: "asks",
            task: "Pick a login provider",
            role: "pick-login-provider",
            provider: "claude",
          },
        ],
      }),
    );
    const child = z
      .array(z.string())
      .catch([])
      .parse(record(control(started).data?.data)?.["threadIds"])[0];
    if (typeof child !== "string") return { metrics: agent.finish(false), note: "not started" };
    await world.askHuman(child as ThreadId);
    // The documented way to collect a child: wait. It must return early, naming the human
    // wait, and never report the child done.
    const waited = await agent.turn(() =>
      agent.call("wait", { threadIds: [child], timeoutSeconds: 5 }),
    );
    const wait = record(control(waited).data?.data);
    const watched = z
      .array(z.object({ threadId: z.string(), state: z.string() }))
      .catch([])
      .parse(wait?.["threads"])
      .find((entry) => entry.threadId === child);
    // agents_status carries a result only once the child has settled.
    const result = await agent.turn(() => agent.call("agents_status", { threadId: child }));
    const resultReady = record(control(result).data?.data)?.["outcome"] !== undefined;
    const claimedDone = agent.calls.some(
      (call) =>
        call.resultText.includes(child) &&
        /"(result_available|completed|done)"/.test(call.resultText),
    );
    const stored = world.store.getThread(child as ThreadId)?.status.state;
    const success =
      wait?.["status"] === "needs_you" &&
      watched?.state === "needs_you" &&
      !resultReady &&
      !claimedDone &&
      stored !== "done";
    return {
      metrics: agent.finish(success),
      note: `wait ${String(wait?.["status"])}, child ${String(watched?.state)}`,
    };
  },
};

export const evalTasks: readonly EvalTask[] = [
  whereAmI,
  delegateTwo,
  browserCheck,
  recentWork,
  visualize,
  recoverBadArgument,
  childWaitingOnHuman,
];

/** `threads_find` returns search hits: one per thread, with its status. */
const ThreadHit = z.object({ threadId: z.string(), status: z.string().optional() });
function threadEntries(data: unknown): { id: string; state: string }[] {
  const hits = z.array(z.unknown()).catch([]).parse(record(data)?.["hits"]);
  return hits.flatMap((hit) => {
    const parsed = ThreadHit.safeParse(hit);
    return parsed.success
      ? [{ id: parsed.data.threadId, state: parsed.data.status ?? "unknown" }]
      : [];
  });
}
function countLive(data: unknown, self: string): number {
  return threadEntries(data).filter((entry) => entry.id !== self && liveStates.has(entry.state))
    .length;
}
const liveStates = new Set(["working", "waiting", "blocked", "waiting_on_human"]);
function liveOthers(world: EvalWorld, self: string): number {
  return world.store
    .listThreads()
    .filter(
      (thread) =>
        thread.id !== self &&
        thread.workspaceId === world.workspaceId &&
        liveStates.has(thread.status.state),
    ).length;
}
function sorted(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)));
}
const accessLabels: Record<string, string> = {
  "Read-only": "read-only",
  Ask: "ask",
  "Auto review": "auto-review",
  "Full access": "full-access",
};
/** The session brief's facts, when the instructions carry one (proposal P1). */
export function readBrief(instructions: string) {
  if (!instructions.includes("ace session facts")) return undefined;
  const pick = (pattern: RegExp) => pattern.exec(instructions)?.[1];
  const project = pick(/Project "([^"]*)"/);
  return {
    project: project ?? null,
    branch: pick(/(?:branch|worktree) "([^"]*)"/) ?? null,
    access: accessLabels[pick(/Access: (Read-only|Ask|Auto review|Full access)/) ?? ""] ?? null,
    liveSiblings: Number(pick(/Live: (\d+) other thread/) ?? Number.NaN),
    delegates: (pick(/Delegate \(tool delegate\) to: ([^\n]*)/) ?? "")
      .split(";")
      .map((entry) => /[a-z]+/.exec(entry)?.[0] ?? ""),
  };
}
/** Field paths named by an error payload, if it names any. */
export function issuePaths(text: string): string[] {
  const payload = record(parseJson(text));
  const issues = z
    .array(z.object({ path: z.string() }).passthrough())
    .catch([])
    .parse(payload?.["issues"]);
  return issues.map((issue) => issue.path);
}
/** Fix only the named fields: remove unknown ones, restore intended ones. */
export function repair(
  sent: Record<string, unknown>,
  intended: Record<string, unknown>,
  paths: readonly string[],
): Record<string, unknown> {
  const next = { ...sent };
  for (const path of paths) {
    const key = path.split(/[.[]/)[0] ?? path;
    if (key in intended) next[key] = intended[key];
    else delete next[key];
  }
  return next;
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
