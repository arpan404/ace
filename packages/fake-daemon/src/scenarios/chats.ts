import type { Fact } from "@ace/core";
import type { ProviderKind } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import type { AgedScenario } from "./home-list.ts";
import { endTurn, message, rootAgent, tool, turn } from "./facts.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/**
 * A chat: a thread in its own hidden chat project, with no folder of the person's (ADR 0099).
 * Without a reply it is still working.
 */
export function chatScenario(
  key: string,
  title: string,
  provider: ProviderKind,
  ask: string,
  reply: string | undefined,
): Scenario {
  const project = `chat-${key}`;
  const facts: Fact[] = [
    rootAgent(provider, `/fake/chats/${project}`),
    turn("root"),
    message("root", "ask", "user", ask),
  ];
  if (reply) facts.push(message("root", "reply", "assistant", reply), endTurn("root"));
  return {
    thread: {
      id: `thread-chat-${key}`,
      workspaceId: project,
      title,
      provider,
      details: {
        workspace: { id: project, name: "Chat", path: `/fake/chats/${project}`, kind: "chat" },
        mode: "local",
      },
    },
    steps: [{ kind: "facts", facts }],
  };
}

/**
 * Chats across the days, so the Chats panel shows each of its groups: one still working and one
 * finished but not yet opened today, then yesterday, earlier this week and older.
 */
export function chats(): AgedScenario[] {
  return [
    {
      scenario: chatScenario(
        "regex",
        "Regex for semver ranges",
        "claude",
        "Write a regex that matches semver ranges like ^1.2.3 and >=2.0.0 <3.",
        undefined,
      ),
      agoMs: 2 * minute,
    },
    {
      scenario: chatScenario(
        "sql-window",
        "Window functions vs GROUP BY",
        "codex",
        "When should I reach for a window function instead of GROUP BY?",
        "Use a window function when you need the aggregate beside each row rather than one row per group.",
      ),
      agoMs: 35 * minute,
    },
    {
      scenario: chatScenario(
        "trip",
        "Three days in Lisbon",
        "claude",
        "Plan three relaxed days in Lisbon in November.",
        "Day one: Alfama and the castle; day two: Belém; day three: Sintra by train.",
      ),
      agoMs: day + 2 * hour,
    },
    {
      scenario: chatScenario(
        "tls",
        "How TLS 1.3 handshakes work",
        "codex",
        "Explain the TLS 1.3 handshake in plain terms.",
        "One round trip: the client guesses the key share, the server answers with its own and the certificate.",
      ),
      agoMs: 3 * day,
    },
    {
      scenario: chatScenario(
        "rust-lifetimes",
        "Rust lifetimes, briefly",
        "claude",
        "Give me the shortest useful explanation of Rust lifetimes.",
        "A lifetime names how long a borrow is valid; the compiler checks no borrow outlives what it points at.",
      ),
      agoMs: 5 * day,
    },
    {
      scenario: chatScenario(
        "espresso",
        "Dialing in espresso",
        "opencode",
        "My espresso tastes sour. What should I change first?",
        "Grind finer first, then raise the dose or the temperature a little.",
      ),
      agoMs: 12 * day,
    },
    {
      scenario: chatScenario(
        "resume",
        "Tighten my resume summary",
        "claude",
        "Make this summary shorter and plainer.",
        "Backend engineer who ships reliable services and keeps them fast.",
      ),
      agoMs: 40 * day,
    },
  ];
}

/**
 * A chat whose agent asks to run a command and waits for the person's answer: a request, so it
 * needs them (the Inbox, the Chats dot).
 */
export function askingChatScenario(key: string, title: string, ask: string, command: string) {
  const scenario = chatScenario(key, title, "claude", ask, undefined);
  const facts: Fact[] = [
    tool("root", "run-call", {
      kind: "shell",
      title: `Run ${command}?`,
      status: "awaiting_approval",
      detail: { kind: "shell", command },
    }),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "run",
      blocking: true,
      item: "run-call",
      request: {
        kind: "approval",
        title: `Run ${command}?`,
        description: "Reads the folder; changes nothing.",
        options: [
          { id: "allow", label: "Approve", kind: "allow_once" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
      },
    },
  ];
  return {
    ...scenario,
    steps: [...scenario.steps, { kind: "facts", facts }, { kind: "await", interaction: "run" }],
  } satisfies Scenario;
}

/**
 * Chats on the fake world's build server (ADR 0102), so the Chats panel shows another machine's
 * chats, its device filter and machine names: one asking now, one from yesterday, one older.
 */
export function buildServerChats(): AgedScenario[] {
  return [
    {
      scenario: askingChatScenario(
        "disk-usage",
        "Why is the disk almost full?",
        "The build server's disk is at 94%. What is taking the space?",
        "du -sh /var/lib/docker",
      ),
      agoMs: 4 * minute,
    },
    {
      scenario: chatScenario(
        "cron",
        "Cron syntax for every weekday at 6",
        "codex",
        "Cron for every weekday at 6 in the morning?",
        "0 6 * * 1-5",
      ),
      agoMs: day + 5 * hour,
    },
    {
      scenario: chatScenario(
        "nginx",
        "Nginx gzip settings",
        "claude",
        "Sensible gzip settings for nginx?",
        "gzip on; gzip_types text/css application/javascript application/json; gzip_min_length 1024;",
      ),
      agoMs: 9 * day,
    },
  ];
}
