import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * Spade's team routes (ADR 0132, spade/docs/teams.md) for the fake: groups with a transcript
 * each, templates, and a bot's duplicate, export and import. Tests drive a group's events with
 * the API's `store` and `groupStatus`, and read what the app sent from its `requests`.
 */

type Json = Record<string, unknown>;

export interface FakeSpadeGroupMember {
  agent: string;
  machine: string | null;
  name: string;
  avatar: Json | null;
  away: boolean;
}

export interface FakeSpadeGroup {
  id: string;
  name: string;
  lead: FakeSpadeGroupMember;
  members: FakeSpadeGroupMember[];
  conversation: string;
  created_at: number;
  updated_at: number;
  last_activity: number;
  state: "idle" | "working" | "waiting";
  status: string | null;
  last_message: {
    from: "person" | "agent";
    text: string;
    at: number;
    agent: { id: string; name: string; machine: string | null } | null;
  } | null;
}

/** What the teams need of the rest of the fake. */
export interface FakeTeamsHost {
  agents: readonly { id: string; kind: string; name: string; avatar: Json }[];
  addAgent(fields: { name: string; task?: string; avatar?: Json; model?: string }): { id: string };
  /** Opens an empty conversation for a group. */
  openConversation(id: string): void;
  store(conversation: string, event: Json): void;
  emitStatus(conversation: string, state: string, status: string | null): void;
  now(): number;
}

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => reply({ error }, status);

export class FakeSpadeTeams {
  groups: FakeSpadeGroup[] = [];
  templates: Json[] = [];
  /** What `POST /v1/agents/import` answers in `left_out`. */
  leftOut: string[] = [];
  private sequence = 0;
  private readonly host: FakeTeamsHost;

  constructor(host: FakeTeamsHost) {
    this.host = host;
  }

  /** Adds a group with its conversation; members name bots of other machines by `machine`. */
  addGroup(fields: Partial<FakeSpadeGroup> & { name: string; members: FakeSpadeGroupMember[] }) {
    const id = fields.id ?? `group-${++this.sequence}`;
    const [first] = fields.members;
    if (!first) throw new Error("a group needs members");
    const group: FakeSpadeGroup = {
      lead: first,
      conversation: `c-${id}`,
      created_at: this.host.now(),
      updated_at: this.host.now(),
      last_activity: this.host.now(),
      state: "idle",
      status: null,
      last_message: null,
      ...fields,
      id,
    };
    this.groups.push(group);
    this.host.openConversation(group.conversation);
    return group;
  }

  /** The group's state and few words, on its row and its live stream. */
  status(group: FakeSpadeGroup, state: FakeSpadeGroup["state"], status: string | null): void {
    group.state = state;
    group.status = status;
    this.host.emitStatus(group.conversation, state, status);
  }

  /** The member of this machine with this agent id, as a group lists it. */
  member(agent: string, machine: string | null = null): FakeSpadeGroupMember {
    const bot = machine === null ? this.host.agents.find((each) => each.id === agent) : undefined;
    return { agent, machine, name: bot?.name ?? agent, avatar: bot?.avatar ?? null, away: false };
  }

  groupRoute(method: string, id: string | undefined, sub: string | undefined, body: Json) {
    if (!id && method === "GET")
      return reply({
        groups: this.groups.toSorted((a, b) => b.last_activity - a.last_activity),
      });
    if (!id && method === "POST") {
      const refs = Array.isArray(body.members) ? (body.members as Json[]) : [];
      const members = refs.map((ref) =>
        this.member(String(ref.agent), typeof ref.machine === "string" ? ref.machine : null),
      );
      const lead = typeof body.lead === "string" ? body.lead : undefined;
      const main = this.host.agents.find((agent) => agent.kind === "main");
      if (!lead && main && !members.some((member) => member.agent === main.id && !member.machine))
        members.unshift(this.member(main.id));
      if (members.length < 2 || members.length > 8)
        return problem(400, "A group has 2 to 8 members.");
      const leader = members.find((member) => member.agent === (lead ?? main?.id));
      const group = this.addGroup({
        name: String(body.name ?? ""),
        members,
        ...(leader ? { lead: leader } : {}),
      });
      return reply({ group }, 201);
    }
    const group = this.groups.find((candidate) => candidate.id === id);
    if (!group) return problem(404, "No such group.");
    if (sub === "messages" && method === "POST") {
      const text = String(body.text ?? "");
      const run = `run-${++this.sequence}`;
      this.host.store(group.conversation, { type: "group_message", run, text, from: null });
      group.last_message = { from: "person", text, at: this.host.now(), agent: null };
      return reply({ run }, 202);
    }
    if (sub === "stop" && method === "POST") {
      this.host.store(group.conversation, { type: "group_stopped", run: "run" });
      this.status(group, "idle", null);
      return { status: 204 };
    }
    if (method === "PATCH") {
      if (typeof body.name === "string") group.name = body.name;
      if (Array.isArray(body.members))
        group.members = (body.members as Json[]).map((ref) =>
          this.member(String(ref.agent), typeof ref.machine === "string" ? ref.machine : null),
        );
      if (typeof body.lead === "string") group.lead = this.member(body.lead);
      return reply({ group });
    }
    if (method === "DELETE") {
      this.groups = this.groups.filter((candidate) => candidate !== group);
      return { status: 204 };
    }
    return problem(405, "Not allowed.");
  }

  /** `POST /agents/{id}/duplicate` and `GET /agents/{id}/export`. */
  agentRoute(method: string, id: string, sub: string, body: Json): FakeSpadeAnswer {
    const agent = this.host.agents.find((candidate) => candidate.id === id);
    if (!agent) return problem(404, "No such agent.");
    if (sub === "duplicate" && method === "POST") {
      const name = typeof body.name === "string" ? body.name : `${agent.name} copy`;
      return reply({ agent: this.host.addAgent({ name, avatar: agent.avatar }) }, 201);
    }
    if (sub === "export" && method === "GET")
      return reply({ format: "spade-bot", version: 1, name: agent.name, avatar: agent.avatar });
    return problem(405, "Not allowed.");
  }

  importRoute(body: Json): FakeSpadeAnswer {
    if (body.format !== "spade-bot") return problem(400, "This isn't a bot file.");
    const agent = this.host.addAgent({
      name: String(body.name ?? "Bot"),
      task: String(body.task ?? ""),
    });
    return reply({ agent, left_out: this.leftOut }, 201);
  }
}
