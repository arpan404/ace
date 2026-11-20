/** One agent as the fake Spade stores it, shared by the fake API and the Work tab. */

import type { FakeSpadeSpending } from "./spade-oversight.ts";

type Json = Record<string, unknown>;

export interface FakeSpadeAgent {
  id: string;
  kind: "main" | "bot";
  name: string;
  task: string;
  avatar: Json;
  model: string;
  conversation: string;
  created_at: number;
  updated_at: number;
  last_activity: number;
  /** When it was pinned (ms), as Spade sends it; null or absent when it isn't. */
  pinned_at?: number | null;
  state: "idle" | "working" | "waiting";
  waiting_for: "approval" | "question" | null;
  /** Its cards left for later, not yet answered or dismissed (ADR 0154). */
  questions_for_later?: number;
  status: string | null;
  /** Why its latest reply on a subscription failed (ADR 0133). */
  problem?: string | null;
  last_message: {
    from: "person" | "agent";
    text: string;
    at: number;
    from_agent: { id: string; name: string } | null;
  } | null;
  /** A move to another machine while one runs, or one that failed (ADR 0187). */
  move?: Json | null;
  /** What needs the person since it arrived from another machine. */
  arrived?: Json | null;
  /** The conversation's seen cursor, as Spade sends it; null when never marked. */
  seen_seq?: number | null;
  /** Finished and not seen since; tests set it, and marking the conversation seen clears it. */
  unseen?: boolean;
  /** Its spend (ADR 0135); left out, as an older Spade does, until set. */
  spending?: FakeSpadeSpending;
  review?: boolean | null;
  /** Spade's one level (ADR 0163); left out, as a Spade before access levels does. */
  access?: "auto_review";
  /** Its task: on it, waiting on the person, or done; with whether it carries on by itself. */
  task_state?: {
    status: "working" | "waiting" | "blocked_on_person" | "done";
    note?: string;
  } | null;
  continuing?: boolean;
  /** The bot that made it (ADR 0161); null or absent for the person's own. */
  parent?: { id: string; name: string } | null;
  /** Whether it may make bots, who made it, and whether Undo archived it (ADR 0161, amendment 1). */
  may_create_bots?: "yes" | "ask" | "no";
  made_by?: { id: string; name: string; apps: string[] } | null;
  archived?: boolean;
}
