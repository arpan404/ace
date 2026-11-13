import { z } from "zod";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import {
  AgentId,
  ThreadId,
  WorkspaceId,
  type McpCapability,
  type SpadeComputerTab,
} from "@ace/protocol";
import { memoryTakeovers, type TakeoverStore } from "./computer-drivers.ts";
import { SpadeComputers, type ActiveTab, type BotThread } from "./computers.ts";

export const spade = {
  threadId: ThreadId.parse("spade-host"),
  agentId: AgentId.parse("spade-root"),
  workspaceId: WorkspaceId.parse("spade-project"),
};

const lease = (threadId: ThreadId) =>
  new CredentialRegistry(() => "a".repeat(64)).issue(
    {
      sessionId: "session",
      threadId,
      agentId: AgentId.parse("root"),
      capabilities: ["browser", "screen", "devices", "thread_control"],
    },
    new AbortController().signal,
  ).principal;

/** What a daemon keeps on disk: bots' hidden threads and take-overs, shared by its restarts. */
export function disk() {
  return { threads: new Map<string, BotThread>(), takeovers: memoryTakeovers() };
}

/**
 * ace's tool registry with Spade's bots wired in as the daemon does, and tools that report the
 * thread they ran as: browser, screen, simulator and thread-control ones, plus `browser_act`,
 * which runs until `release` is called or shortly after its call is aborted (never, when
 * `stubborn`). Browsers are a map of each
 * thread's tabs, as ace's browser services would hold them.
 */
export function ace(saved: { threads: Map<string, BotThread>; takeovers: TakeoverStore } = disk()) {
  let clock = 1_000;
  const { threads } = saved;
  /** Each thread's tabs; a thread missing here has none, one in `unreadable` can't be read. */
  const tabs = new Map<string, SpadeComputerTab[]>();
  const unreadable = new Set<string>();
  const active = new Map<string, ActiveTab>();
  const apps = new Map<string, string[]>();
  /** Threads whose screen sessions the person used in the last 3 s. */
  const screenActive = new Set<string>();
  const reports: object[] = [];
  const timers: (() => void)[] = [];
  const computers = new SpadeComputers({
    host: () => spade,
    find: (key) => threads.get(key),
    create(_host, key) {
      const thread = {
        threadId: ThreadId.parse(`thread-${threads.size + 1}`),
        agentId: AgentId.parse(`agent-${threads.size + 1}`),
      };
      threads.set(key, thread);
      return thread;
    },
    tabs: (threadId) => (unreadable.has(threadId) ? undefined : (tabs.get(threadId) ?? [])),
    apps: (threadId) => apps.get(threadId) ?? [],
    activeTab: (threadId) => active.get(threadId),
    screenPersonActive: (threadId) => screenActive.has(threadId),
    botOf: (threadId) =>
      [...threads]
        .find(([, thread]) => thread.threadId === threadId)?.[0]
        .slice("computer:".length),
    report: (bot, kind, report) => reports.push({ bot, kind, ...report }),
    takeovers: saved.takeovers,
    after(_ms, run) {
      timers.push(run);
      return () => timers.splice(timers.indexOf(run), 1);
    },
    now: () => clock,
  });
  const registry = new ToolRegistry({
    scheduler: { after: () => () => {} },
    actAs: (_tool, capability, caller, actingFor) => computers.actAs(capability, caller, actingFor),
  });
  const tool = (name: string, capability: McpCapability) =>
    registry.register({
      name,
      description: name,
      capability,
      timeoutMs: 1000,
      input: z.object({ bot: z.string().optional() }),
      output: z.object({ threadId: z.string() }),
      async run(_input, context) {
        return { threadId: context.caller.threadId };
      },
    });
  tool("browser_tabs", "browser");
  tool("screen_state", "screen");
  tool("sim_act", "devices");
  tool("thread_read", "thread_control");
  /** What `browser_act` did: it saw its abort, then ended (for a backend slow to stop). */
  const acting = { aborted: false, ended: false, stubborn: false, release: () => {} };
  registry.register({
    name: "browser_act",
    description: "browser_act",
    capability: "browser",
    timeoutMs: 1000,
    input: z.object({}),
    output: z.object({ threadId: z.string() }),
    async run(_input, context) {
      await new Promise<void>((resolve) => {
        acting.release = resolve;
        context.signal.addEventListener("abort", () => {
          acting.aborted = true;
          // A backend that takes a moment to stop after its abort; a stubborn one never does.
          if (!acting.stubborn) setTimeout(resolve, 5);
        });
      });
      acting.ended = true;
      return { threadId: context.caller.threadId };
    },
  });
  const call = async (
    name: string,
    options: { args?: object; actingFor?: string; from?: ThreadId } = {},
  ) => {
    const result = await registry.call(
      name,
      options.args ?? {},
      lease(options.from ?? spade.threadId),
      new AbortController().signal,
      options.actingFor ? { actingFor: options.actingFor } : {},
    );
    const text = z.object({ text: z.string() }).parse(result.content[0]).text;
    return result.isError
      ? { error: z.object({ code: z.string() }).parse(JSON.parse(text)).code }
      : { ran: z.object({ threadId: z.string() }).parse(JSON.parse(text)).threadId };
  };
  return {
    computers,
    reports,
    call,
    acting,
    tabs,
    unreadable,
    active,
    apps,
    screenActive,
    timers,
    threadOf: (bot: string) => threads.get(`computer:${bot}`)?.threadId,
    advance: (ms: number) => void (clock += ms),
  };
}
