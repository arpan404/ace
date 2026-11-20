/*
 * A bot's task over time and its own name, as Spade keeps them (spade/docs/agents.md, "A bot's
 * task over time"): each task change is an `agent_configured` event in its conversation with
 * who changed it, from what and why, and `GET /v1/agents/{id}/task/history` lists the versions.
 * A name or face change is a `profile_changed` event.
 */

type Json = Record<string, unknown>;

export interface FakeTaskVersion {
  seq: number;
  at: number;
  task: string;
  /** `person`, `bot`, or "" for the task a bot was made with. */
  by: string;
  why: string;
}

/** What the fake keeps of a bot for this. */
interface Bot {
  id: string;
  name: string;
  task: string;
  avatar: unknown;
  conversation: string;
}

export class FakeSpadeTasks {
  private readonly versions = new Map<string, FakeTaskVersion[]>();
  private sequence = 0;
  private readonly store: (conversation: string, event: Json) => void;
  private readonly now: () => number;

  constructor(store: (conversation: string, event: Json) => void, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** The task a bot was made with, its first version. */
  made(bot: Bot): void {
    if (bot.task) this.push(bot.id, bot.task, "", "");
  }

  /**
   * The bot's task becomes `task`, changed `by` the person or the bot itself: stored as Spade
   * stores it, so its chat and its history follow. The same task again changes nothing.
   */
  change(bot: Bot, task: string, by: "person" | "bot", why = ""): void {
    if (task === bot.task) return;
    const previous = bot.task;
    bot.task = task;
    this.push(bot.id, task, by, why);
    this.store(bot.conversation, {
      type: "agent_configured",
      task,
      model: "openrouter/saved/model",
      change: { by, previous, ...(why ? { why } : {}) },
    });
  }

  /** The bot's name (and maybe its face) changed `by` someone: its `profile_changed`. */
  renamed(bot: Bot, by: "person" | "bot", face: boolean): void {
    this.store(bot.conversation, {
      type: "profile_changed",
      name: bot.name,
      by,
      ...(face ? { face: true } : {}),
    });
  }

  /** `GET /v1/agents/{id}/task/history`: newest first. */
  history(id: string): Json {
    return { versions: [...(this.versions.get(id) ?? [])].reverse() };
  }

  private push(id: string, task: string, by: string, why: string) {
    const list = this.versions.get(id) ?? [];
    list.push({ seq: ++this.sequence, at: this.now(), task, by, why });
    this.versions.set(id, list);
  }
}
