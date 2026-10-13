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
const control = (result: CallResult) => Control.safeParse(result.data);
const record = (value: unknown) =>
  z.record(z.string(), z.unknown()).safeParse(value).data ?? undefined;

const whereAmI: EvalTask = {
  id: "where-am-i",
  title: "Find where I am: project, branch, access mode, title state, live siblings",
  gate: false,
  async run(world) {
    await world.liveThread("Refactor the cart");
    const { agent, threadId } = await world.agent({});
    const thread = world.store.getThread(threadId);
    const truth = {
      project: "shop",
      branch: world.branch,
      permissionMode: thread?.permission?.effective ?? null,
      provisional: thread?.titleSource === "provisional",
      liveSiblings: liveOthers(world, threadId),
    };
    const seen: Record<string, unknown> = {};
    await agent.turn(async () => {
      const [status, info] = await Promise.all([
        agent.call("ace_status", {}),
        agent.call("ace_thread_info", {}),
      ]);
      seen["permissionMode"] = record(status.data)?.["permissionMode"] ?? null;
      const own = record(record(info.data)?.["thread"]);
      seen["provisional"] = own?.["titleSource"] === "provisional";
      const details = record(own?.["details"]);
      seen["project"] = record(details?.["workspace"])?.["name"];
      seen["branch"] = details?.["branch"] ?? null;
      seen["workspaceId"] = own?.["workspaceId"];
    });
    await agent.turn(async () => {
      const [list, project] = await Promise.all([
        agent.call("ace_threads_list", {}),
        seen["project"] === undefined
          ? agent.call("ace_project_read", { workspaceId: seen["workspaceId"] })
          : undefined,
      ]);
      if (project) seen["project"] = record(control(project).data?.data)?.["name"];
      seen["liveSiblings"] = countLive(control(list).data?.data, threadId);
    });
    // ace did not say which branch: the model asks git with its own shell.
    if (typeof seen["branch"] !== "string")
      seen["branch"] = await agent.turn(async () =>
        agent.ownTool("shell", { command: "git branch --show-current" }, world.branch),
      );
    const { workspaceId: _id, ...answer } = seen;
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
    const provider = await agent.turn(async () => {
      const catalog = control(await agent.call("ace_agents_catalog", {}));
      const instances = z
        .object({ instances: z.array(z.object({ provider: z.string(), installed: z.boolean() })) })
        .safeParse(catalog.data?.data).data?.instances;
      return instances?.find((entry) => entry.installed && entry.provider === "claude")?.provider;
    });
    if (!provider) return { metrics: agent.finish(false), note: "no provider found" };
    const tasks = [
      { requestId: "fix-header", task: "Fix the header spacing", answer: "Header spacing fixed" },
      { requestId: "fix-footer", task: "Fix the footer links", answer: "Footer links fixed" },
    ];
    const children = await agent.turn(() =>
      Promise.all(
        tasks.map(async (task) => {
          const result = control(
            await agent.call("delegate_task", {
              requestId: task.requestId,
              task: task.task,
              role: "implementer",
              provider,
            }),
          );
          return record(result.data?.data)?.["threadId"];
        }),
      ),
    );
    const ids = children.filter((id): id is string => typeof id === "string");
    if (ids.length !== tasks.length) return { metrics: agent.finish(false), note: "not started" };
    const results = await agent.turn(async () => {
      const waits = ids.map((threadId) => agent.call("ace_thread_wait", { threadId }));
      // The children finish while the parent waits.
      for (const [index, id] of ids.entries())
        await world.complete(id as ThreadId, tasks[index]?.answer ?? "");
      return Promise.all(waits);
    });
    const texts = results.map((result) => JSON.stringify(control(result).data?.data ?? ""));
    const success = tasks.every((task, index) => texts[index]?.includes(task.answer));
    return { metrics: agent.finish(success), note: `${ids.length} children settled` };
  },
};

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
    const list = await agent.turn(() => agent.call("ace_threads_list", {}));
    const other = threadEntries(control(list).data?.data).find((entry) => entry.id !== threadId);
    if (!other) return { metrics: agent.finish(false), note: "no earlier thread found" };
    const read = await agent.turn(() => agent.call("ace_thread_read", { threadId: other.id }));
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
    // Guidance says to preview before rendering, when a separate preview tool exists.
    if (agent.has("ace_html_preview"))
      await agent.turn(() => agent.call("ace_html_preview", { html }));
    const rendered = await agent.turn(() => agent.call("ace_html_render", page));
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
        tool: "ace_thread_rename",
        sent: { threadId, titel: "Login page" },
        intended: { threadId, title: "Login page" },
      },
      {
        tool: "delegate_task",
        sent: { requestId: "slip", task: "Add tests", role: "tester", provider: "gpt-5" },
        intended: { requestId: "slip", task: "Add tests", role: "tester", provider: "claude" },
      },
      { tool: "ace_threads_list", sent: { limit: 500 }, intended: { limit: 10 } },
      {
        tool: "ace_thread_search",
        sent: { threadId, q: "login" },
        intended: { threadId, query: "login" },
      },
      {
        tool: "ace_html_render",
        sent: { title: "x", html: "<p>x</p>", mode: "fancy" },
        intended: { title: "x", html: "<p>x</p>", mode: "static" },
      },
      { tool: "ace_notify_user", sent: { message: "done" }, intended: { text: "done" } },
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
      agent.call("delegate_task", {
        requestId: "asks",
        task: "Pick a login provider",
        role: "implementer",
        provider: "claude",
      }),
    );
    const child = record(control(started).data?.data)?.["threadId"];
    if (typeof child !== "string") return { metrics: agent.finish(false), note: "not started" };
    await world.askHuman(child as ThreadId);
    const [status, result] = await agent.turn(() =>
      Promise.all([
        agent.call("ace_agent_status", { threadId: child }),
        agent.call("ace_agent_result", { threadId: child }),
      ]),
    );
    const state = record(control(status).data?.data)?.["state"];
    const resultReady = control(result).data?.ok === true;
    const claimedDone = agent.calls.some(
      (call) =>
        call.resultText.includes(child) && /"(result_available|completed)"/.test(call.resultText),
    );
    const stored = world.store.getThread(child as ThreadId)?.status.state;
    const success =
      state === "waiting_on_human" && !resultReady && !claimedDone && stored !== "done";
    return { metrics: agent.finish(success), note: `child state ${String(state)}` };
  },
};

const readOnlyNoScreen: EvalTask = {
  id: "read-only-no-screen",
  title: "In read-only mode, screen tools are absent and never attempted",
  gate: true,
  async run(world) {
    // Control: with full access the same daemon does serve computer use.
    const { agent: full } = await world.agent({});
    const served = full.has("screen_request_app");
    const { agent, threadId } = await world.agent({ permissionMode: "read-only" });
    const effective = world.store.getThread(threadId)?.permission?.effective;
    const listed = agent.tools.filter((tool) => /^(screen|device)_/.test(tool.name));
    // Asked to click Save in a native app: only an offered tool can be tried.
    if (agent.has("screen_request_app"))
      await agent.turn(() =>
        agent.call("screen_request_app", { bundleId: "com.apple.Notes", reason: "click Save" }),
      );
    const attempted = agent.calls.filter((call) => /^(screen|device)_/.test(call.tool)).length;
    return {
      metrics: agent.finish(served && listed.length === 0 && attempted === 0),
      note: `effective ${String(effective)}; control serves screen: ${served}; read-only lists ${listed.length}, attempted ${attempted}`,
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
  readOnlyNoScreen,
];

/** `ace_threads_list` returns search hits: one per thread, with its status. */
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
