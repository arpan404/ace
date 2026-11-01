import type { Fact } from "@ace/core";
import type { ProviderKind } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import type { AgedScenario } from "./home-list.ts";
import { endTurn, message, rootAgent, turn } from "./facts.ts";

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
