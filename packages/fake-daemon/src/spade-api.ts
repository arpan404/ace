import type { FakeSpade, FakeSpadeAnswer, FakeSpadeRequest, FakeSpadeServer } from "./spade.ts";
import { FakeSpadeComputer, fakeFileRevision, fakeStale } from "./spade-computer.ts";
import { FakeSpadeConnectors } from "./spade-connectors-api.ts";
import { FakeSpadeKnowledge } from "./spade-knowledge.ts";
import { FakeSpadeNotes } from "./spade-notes.ts";
import { FakeSpadeRoles } from "./spade-roles.ts";
import { FakeSpadeServices } from "./spade-services.ts";
import { FakeSpadeSearch } from "./spade-search.ts";
import { FakeSpadeOversight } from "./spade-oversight.ts";
import { FakeSpadeSecurity } from "./spade-security.ts";
import { FakeSpadeRoutines } from "./spade-routines.ts";
import { base64Bytes, sha256Hex } from "./sha256.ts";
import { FakeSpadeTeams } from "./spade-teams.ts";
import { FakeSpadeWakes } from "./spade-wakes.ts";
import { FakeSpadeWork } from "./spade-work.ts";
import { faceForId, repairFace, storedBotFace } from "@ace/ui-core/bot-face";

/*
 * A stateful stand-in for Spade's local API (ADR 0126, 0127), in Spade's own JSON: agents with
 * one conversation each, endpoints and their models, stored events and live streams. Tests and
 * the fake app drive it (`reply`, `status`, `ask`) and read what the app sent (`requests`).
 */

type Json = Record<string, unknown>;

import type { FakeSpadeAgent } from "./spade-agent.ts";
export type { FakeSpadeAgent } from "./spade-agent.ts";

interface Stored {
  seq: number;
  at: number;
  event: Json;
}

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => reply({ error }, status);

export class FakeSpadeApi implements FakeSpadeServer {
  agents: FakeSpadeAgent[] = [];
  endpoints: Json[] = [];
  presets: Json[] = [];
  fastModel: string | null = null;
  /** `new_bot_model`: the model new bots start on; null, the first usable one. */
  newBotModel: string | null = null;
  /** `endpoint/model` for voice messages (ADR 0134). */
  transcriptionModel: string | null = null;
  /** Stored images by hash with their media type; any other hash answers 404. */
  images = new Map<string, string>();
  /** What `POST /v1/transcriptions` answers. */
  transcript = "";
  /** False: this machine has no keychain, so key writes answer 503. */
  keychain = true;
  /** A status every key write answers with, to stage a failure. */
  keyFailure: number | undefined;
  /** A status every read of one file answers with, to stage a failure. */
  fileReadFailure: number | undefined;
  /** While set, reads of one file wait for it (`holdFileReads`). */
  private fileReadsHeld: Promise<void> | undefined;

  /** Holds every read of one file until the result is called, as a slow read would. */
  holdFileReads(): () => void {
    const held = Promise.withResolvers<void>();
    this.fileReadsHeld = held.promise;
    return () => {
      this.fileReadsHeld = undefined;
      held.resolve();
    };
  }
  /** True: a card's settling event is stored but never sent live, so a follower misses it. */
  missQuestionSettles = false;
  /** Settlements of question cards accepted while `holdQuestionSettles` holds them. */
  private heldSettles: (() => void)[] | undefined;

  /**
   * Accepts a card's answer, deferral or dismissal at once but stores it only when the result is
   * called, as a Spade slow to send the update would.
   */
  holdQuestionSettles(): () => void {
    const held: (() => void)[] = [];
    this.heldSettles = held;
    return () => {
      if (this.heldSettles === held) this.heldSettles = undefined;
      for (const settle of held.splice(0)) settle();
    };
  }
  /** True: the keychain hasn't answered (a prompt is open), so keys read as not known yet. */
  keysPending = false;
  characterAvatars = true;
  /** `PUT /v1/main` without `by`: the old election's switch, obeyed until a host record. */
  mainEnabled = true;
  /** This machine's host id, as Spade reads it from ace's home. */
  here: string | undefined = undefined;
  /** Where Spade lives, as this machine last heard (ADR 0187). */
  hostRecord: Json | undefined = undefined;
  /** The person switched Spade off here. */
  mainOff = false;
  /** Moves the person accepted here, by id, with the bot each brings. */
  acceptedMoves = new Map<string, string>();
  /** What the person accepted for each move, as sent. */
  acceptances = new Map<string, Json>();
  /** Names of the machines a move can go to, by host id. */
  machineNames = new Map<string, string>();
  /** Whether Spade's main bot shows here, as Spade decides it. */
  private mainShown(): boolean {
    if (this.mainOff) return false;
    if (this.hostRecord && this.here) return this.hostRecord.host === this.here;
    return this.mainEnabled;
  }
  /** The person's subscriptions as ace lists them (ADR 0133), in Spade's JSON. */
  subscriptions: Json[] = [];
  /** What each endpoint lists live, by endpoint id; a number answers with that status. */
  liveModels = new Map<string, Json[] | number>();
  /** Each agent's workspace files (ADR 0130), by path relative to it; folders are implied. */
  files = new Map<string, Record<string, string>>();
  /** Empty folders made in each agent's workspace, by agent id. */
  folders = new Map<string, Set<string>>();
  /** Each bot's computer: driver, surfaces, terminal and file writes. */
  readonly computer: FakeSpadeComputer;
  /** Each agent's skill proposals, in Spade's JSON. */
  proposals = new Map<string, Json[]>();
  /** Spade's skill store (`GET /v1/skills`), in Spade's JSON; Add to ace's library moves one out. */
  skillStore: { skills: Json[]; ace: boolean } = { skills: [], ace: false };
  /** What the bots remember, their own and the shared ones (ADR 0128). */
  readonly notes: FakeSpadeNotes;
  /** First run, as Spade keeps it (`GET /v1/onboarding`), finished unless a test asks again. */
  readonly onboarding: Record<string, string | null> = { about_you: "done", starters: "done" };
  /** Where each note or page came from, by its id, as `GET …/provenance` answers. */
  readonly provenance = new Map<string, Json>();
  /** The sources each bot learned from, as `GET /v1/agents/{id}/learned` answers. */
  readonly learned = new Map<string, Json[]>();
  /** Each `POST …/learned/forget`, by bot, its source key. */
  readonly forgotSources: { agent: string; source: string }[] = [];
  /** Model servers on this computer, as `GET /v1/endpoints/local` answers (`{id, name, …}`). */
  localServers: Json[] = [];
  /** Each bot's knowledge pages and past work (ADR 0164). */
  readonly knowledge: FakeSpadeKnowledge;
  /** Each bot's services (ADR 0160). */
  readonly services = new FakeSpadeServices();
  /** Models for other work, for every bot and on each (ADR 0162). */
  readonly roles = new FakeSpadeRoles();
  /** Every request the app sent, in order. */
  readonly requests: FakeSpadeRequest[] = [];
  /** The person's connected apps and each bot's allow list (ADR 0131). */
  readonly connectors = new FakeSpadeConnectors();
  /** Caps, the review and the activity log (ADR 0135). */
  readonly oversight = new FakeSpadeOversight();
  /** The sandbox, and each bot's network, grants, egress log and checkpoints (ADR 0167). */
  readonly security: FakeSpadeSecurity;
  /** Web search settings: the SearXNG address and whether a Brave key is set. */
  readonly search = new FakeSpadeSearch();
  /** Each bot's wakes, folded from its events, and the digests (ADR 0160, 0165). */
  readonly wakes: FakeSpadeWakes;
  private readonly events = new Map<string, Stored[]>();
  private sequence = 0;
  private readonly spade: FakeSpade;
  private readonly now: () => number;
  /** Each bot's routines and heartbeat (ADR 0129). */
  readonly routines: FakeSpadeRoutines;
  /** Groups, templates, duplicate, export and import (ADR 0132). */
  readonly teams: FakeSpadeTeams;
  /** Each bot's goal and plan, and its tree of workers (ADR 0159, 0161). */
  readonly work = new FakeSpadeWork(() => this.agents);

  constructor(spade: FakeSpade, now: () => number = () => 1_000) {
    this.spade = spade;
    this.now = now;
    this.notes = new FakeSpadeNotes(now);
    this.knowledge = new FakeSpadeKnowledge(now);
    this.routines = new FakeSpadeRoutines(now);
    this.security = new FakeSpadeSecurity(now);
    const agents = () => this.agents;
    this.teams = new FakeSpadeTeams({
      // The list as it is now: a delete replaces it.
      get agents() {
        return agents();
      },
      addAgent: (fields) => this.addAgent(fields),
      openConversation: (id) => void this.events.set(id, this.events.get(id) ?? []),
      store: (conversation, event) => this.store(conversation, event),
      emitStatus: (conversation, state, status, waiting) =>
        this.spade.emit(
          `/v1/conversations/${conversation}/live`,
          "status",
          waiting ? { state, status, waiting_member: waiting } : { state, status },
        ),
      now,
    });
    const conversationOf = (id: string) =>
      this.agents.find((agent) => agent.id === id)?.conversation;
    this.computer = new FakeSpadeComputer({
      now,
      emitConversation: (agent, event, data) => {
        const conversation = conversationOf(agent);
        if (conversation) this.spade.emit(`/v1/conversations/${conversation}/live`, event, data);
      },
      emitTerminal: (agent, event, data) =>
        this.spade.emit(`/v1/agents/${encodeURIComponent(agent)}/terminal/live`, event, data),
      files: (agent) => {
        const files = this.files.get(agent) ?? {};
        this.files.set(agent, files);
        return files;
      },
      folders: (agent) => {
        const folders = this.folders.get(agent) ?? new Set<string>();
        this.folders.set(agent, folders);
        return folders;
      },
      exists: (agent) => this.agents.some((candidate) => candidate.id === agent),
    });
    this.wakes = new FakeSpadeWakes({
      conversationOf,
      events: (conversation) => (this.events.get(conversation) ?? []).map((stored) => stored.event),
      store: (conversation, event) => this.store(conversation, event),
    });
    spade.serve(this);
  }

  /** Stages what the daemon says of Spade, read when a client next asks (`spade.status`). */
  setStatus(status: FakeSpade["status"]): void {
    this.spade.status = status;
  }

  /** Adds an agent with its conversation; returns it. */
  addAgent(fields: Partial<FakeSpadeAgent> & { name: string }): FakeSpadeAgent {
    const id = fields.id ?? `agent-${++this.sequence}`;
    const agent: FakeSpadeAgent = {
      kind: "bot",
      task: "",
      avatar: storedBotFace(faceForId(id)) as Json,
      model: "openrouter/saved/model",
      conversation: `c-${id}`,
      created_at: this.now(),
      updated_at: this.now(),
      last_activity: this.now(),
      state: "idle",
      waiting_for: null,
      status: null,
      last_message: null,
      ...fields,
      id,
    };
    this.agents.push(agent);
    this.events.set(agent.conversation, []);
    return agent;
  }

  /** Stores an event in a conversation and sends it to its live streams. */
  store(conversation: string, event: Json): void {
    const stored = this.keep(conversation, event);
    this.spade.emit(`/v1/conversations/${conversation}/live`, "stored", stored);
  }

  /** Stores an event without sending it live, as a stream that fell behind would miss it. */
  private keep(conversation: string, event: Json): Json {
    const list = this.events.get(conversation) ?? [];
    const stored = { seq: list.length + 1, at: this.now(), event };
    list.push(stored);
    this.events.set(conversation, list);
    return stored;
  }

  /** The agent's state and its few words, on its row and its live stream. */
  status(agent: FakeSpadeAgent, state: FakeSpadeAgent["state"], status: string | null): void {
    agent.state = state;
    agent.waiting_for = state === "waiting" ? (agent.waiting_for ?? "approval") : null;
    agent.status = status;
    this.spade.emit(`/v1/conversations/${agent.conversation}/live`, "status", { state, status });
  }

  /** A whole reply from the agent: started, its words, finished. */
  reply(agent: FakeSpadeAgent, text: string, id = `r${++this.sequence}`): void {
    this.store(agent.conversation, { type: "reply_started", reply: id });
    this.store(agent.conversation, { type: "step_finished", reply: id, text });
    this.store(agent.conversation, { type: "reply_finished", reply: id, text });
    agent.last_message = { from: "agent", text, at: this.now(), from_agent: null };
    this.status(agent, "idle", null);
  }

  /** A reply that opens and asks the person to approve a call. */
  ask(
    agent: FakeSpadeAgent,
    callId: string,
    name: string,
    args?: unknown,
    id = `r${++this.sequence}`,
  ): void {
    this.request(agent, { callId, name, args, reply: id });
  }

  /** A call the auto-review asked the person about rather than approve, with its reason. */
  escalate(
    agent: FakeSpadeAgent,
    callId: string,
    name: string,
    args: unknown,
    reviewerReason: string,
    /** Which of Spade's judges stopped it (ADR 0163, amendment 3), when one did. */
    stopped?: string,
  ): void {
    this.request(agent, {
      callId,
      name,
      args,
      reply: `r${++this.sequence}`,
      reviewerReason,
      stopped,
    });
  }

  /** A call Spade asked about because of its effect (ADR 0171), not a reviewer's doubt. */
  askAbout(
    agent: FakeSpadeAgent,
    callId: string,
    name: string,
    args: unknown,
    ask: "undeclared" | "outside_sandbox" | "drive",
    app?: string,
  ): void {
    this.request(agent, { callId, name, args, reply: `r${++this.sequence}`, ask, app });
  }

  private request(
    agent: FakeSpadeAgent,
    call: {
      callId: string;
      name: string;
      args: unknown;
      reply: string;
      reviewerReason?: string;
      ask?: string;
      app?: string | undefined;
      stopped?: string | undefined;
    },
  ): void {
    const { callId, name, args, reply: id } = call;
    this.store(agent.conversation, { type: "reply_started", reply: id });
    this.store(agent.conversation, {
      type: "step_finished",
      reply: id,
      text: "",
      calls: [{ id: callId, name }],
    });
    this.store(agent.conversation, {
      type: "approval_requested",
      reply: id,
      call_id: callId,
      name,
      ...(args === undefined ? {} : { arguments: args }),
      ...(call.reviewerReason === undefined ? {} : { reviewer_reason: call.reviewerReason }),
      ...(call.ask === undefined ? {} : { ask: call.ask }),
      ...(call.app === undefined ? {} : { app: call.app }),
      ...(call.stopped === undefined ? {} : { stopped: call.stopped }),
    });
    this.status(agent, "waiting", "Waiting for you");
  }

  /** A reply that opens and asks the person a question (`ask_user`), then waits. */
  question(agent: FakeSpadeAgent, callId: string, question: string, id = `r${++this.sequence}`) {
    this.store(agent.conversation, { type: "reply_started", reply: id });
    this.store(agent.conversation, {
      type: "step_finished",
      reply: id,
      text: "",
      calls: [{ id: callId, name: "ask_user", arguments: { question } }],
    });
    this.store(agent.conversation, {
      type: "tool_started",
      reply: id,
      call_id: callId,
      name: "ask_user",
    });
    this.store(agent.conversation, {
      type: "question_asked",
      reply: id,
      call_id: callId,
      question,
    });
    agent.waiting_for = "question";
    this.status(agent, "waiting", null);
  }

  /**
   * A reply that asks a card of questions (ADR 0154) and waits on it; with `later`, the bot asked
   * without waiting, so it is for later from the start and the reply ends.
   */
  card(agent: FakeSpadeAgent, callId: string, questions: Json[], later = false): void {
    const id = `r${++this.sequence}`;
    const prompts = questions.map((each) => String(each.prompt ?? "")).join("\n");
    this.store(agent.conversation, { type: "reply_started", reply: id });
    this.store(agent.conversation, {
      type: "step_finished",
      reply: id,
      text: "",
      calls: [{ id: callId, name: "ask_user", arguments: { questions } }],
    });
    this.store(agent.conversation, {
      type: "question_asked",
      reply: id,
      call_id: callId,
      question: prompts,
      questions,
    });
    if (later) {
      this.store(agent.conversation, { type: "question_deferred", call_id: callId, by_bot: true });
      this.store(agent.conversation, { type: "reply_finished", reply: id, text: "" });
      // Spade counts each question of the card.
      agent.questions_for_later = (agent.questions_for_later ?? 0) + questions.length;
      return;
    }
    agent.waiting_for = "question";
    this.status(agent, "waiting", null);
  }

  /** The answer the next card reply gets instead of 202: a status and Spade's error words. */
  refuseQuestion: { status: number; error: string } | undefined;

  /** The bodies the app sent to `method path`, parsed. */
  /** The paths of the requests sent with `method` whose path matches `pattern`, in order. */
  sentPaths(method: string, pattern: RegExp): string[] {
    return this.requests
      .filter((request) => request.method === method && pattern.test(request.path))
      .map((request) => request.path);
  }

  sent(method: string, path: string): Json[] {
    return this.requests
      .filter((request) => request.method === method && request.path === path)
      .map((request) => (request.body ? (JSON.parse(request.body) as Json) : {}));
  }

  open(path: string): { event: string; data: string }[] {
    const terminal = /^\/v1\/agents\/([^/]+)\/terminal\/live\?after=(\d+)/.exec(path);
    if (terminal)
      return this.computer.backlog(decodeURIComponent(terminal[1] ?? ""), Number(terminal[2]));
    const match = /^\/v1\/conversations\/([^/]+)\/live\?after=(\d+)/.exec(path);
    if (!match) return [];
    const conversation = decodeURIComponent(match[1] ?? "");
    const list = this.events.get(conversation) ?? [];
    const after = Number(match[2]);
    const agent =
      this.agents.find((candidate) => candidate.conversation === conversation) ??
      this.teams.groups.find((candidate) => candidate.conversation === conversation);
    return [
      ...list
        .filter((stored) => stored.seq > after)
        .map((stored) => ({ event: "stored", data: JSON.stringify(stored) })),
      { event: "caught_up", data: JSON.stringify({ seq: list.length }) },
      // As Spade does: the agent's state once after the backlog, then on every change.
      ...(agent
        ? [{ event: "status", data: JSON.stringify({ state: agent.state, status: agent.status }) }]
        : []),
      // A bot's computer once on connect, then on every change.
      ...(agent && this.agents.some((bot) => bot === agent)
        ? [{ event: "computer", data: JSON.stringify(this.computer.of(agent.id)) }]
        : []),
    ];
  }

  /** The global roles; the review's model is the oversight's own setting, as on Spade. */
  private rolesRoute(method: string, body: Json): FakeSpadeAnswer {
    this.roles.global.review = this.oversight.oversight.review_model;
    const answered = this.roles.globalRoute(method, body);
    this.oversight.oversight.review_model = this.roles.global.review ?? null;
    return answered;
  }

  answer(request: FakeSpadeRequest): FakeSpadeAnswer | Promise<FakeSpadeAnswer> {
    this.requests.push(request);
    const [path = "", query = ""] = request.path.split("?");
    const parts = path.split("/").slice(2).map(decodeURIComponent);
    const body = request.body ? (JSON.parse(request.body) as Json) : {};
    const [root, id, sub, subId] = parts;
    if (root === "agents" && id && (sub === "computer" || sub === "terminal" || sub === "files"))
      return this.computer.route(
        request.method,
        id,
        parts.slice(2),
        new URLSearchParams(query),
        body,
      );
    if (root === "agents" && id && sub === "workspace") {
      const reading = request.method === "GET" && subId === "file";
      if (reading && this.fileReadFailure !== undefined)
        return problem(this.fileReadFailure, "Spade couldn't read the file.");
      const answered = this.workspaceRoute(request.method, id, subId, new URLSearchParams(query));
      // Held: answers as the file was when asked, once let go.
      const held = this.fileReadsHeld;
      return reading && held ? held.then(() => answered) : answered;
    }
    if (root === "agents" && id && sub === "skill-proposals")
      return this.proposalRoute(request.method, id, subId, body);
    if (root === "agents" && id && sub === "connectors") {
      const agent = this.agents.find((candidate) => candidate.id === id);
      if (!agent) return problem(404, "No such agent.");
      return this.connectors.agentRoute(request.method, id, agent.kind === "main", body);
    }
    if (root === "skills" && request.method === "GET") return reply(this.skillStore);
    if (root === "skills" && id && sub === "add-to-ace" && request.method === "POST") {
      if (!this.skillStore.ace) return problem(503, "ace isn't running.");
      const skills = this.skillStore.skills;
      if (!skills.some((skill) => skill.id === id)) return problem(404, "no such skill");
      this.skillStore.skills = skills.filter((skill) => skill.id !== id);
      return reply({ skill_id: `skl_${id}` });
    }
    if (root === "oversight") return this.oversight.route(request.method, body);
    if (root === "security") return this.security.machineRoute(request.method, id, body);
    if (
      root === "agents" &&
      id &&
      (sub === "security" || sub === "grants" || sub === "checkpoints")
    )
      return this.security.agentRoute(
        request.method,
        this.agents.find((candidate) => candidate.id === id),
        parts.slice(2),
        new URLSearchParams(query),
        body,
      );
    if (root === "agents" && id && sub === "wakes")
      return this.wakes.route(request.method, id, subId, parts[4]);
    if (root === "digests" && request.method === "GET")
      return this.wakes.list(new URLSearchParams(query));
    if (root === "agents" && id && (sub === "oversight" || sub === "activity")) {
      const agent = this.agents.find((candidate) => candidate.id === id);
      if (!agent) return problem(404, "No such agent.");
      return sub === "activity"
        ? this.oversight.activityRoute(id, new URLSearchParams(query))
        : this.oversight.agentRoute(request.method, agent, body);
    }
    if (root === "agents" && id && (sub === "knowledge" || sub === "episodes")) {
      if (!this.agents.some((agent) => agent.id === id)) return problem(404, "No such agent.");
      const rest = sub === "episodes" ? ["episodes"] : parts.slice(3);
      return this.knowledge.agentRoute(request.method, id, rest, new URLSearchParams(query), body);
    }
    if (root === "knowledge" && id) return this.knowledge.entryRoute(request.method, id, sub, body);
    if (root === "episodes" && id) return this.knowledge.episodeRoute(request.method, id);
    if (root === "agents" && id && sub === "services") {
      if (!this.agents.some((agent) => agent.id === id)) return problem(404, "No such agent.");
      return this.services.route(request.method, id, parts.slice(3), new URLSearchParams(query));
    }
    if (root === "models" && id === "roles") return this.rolesRoute(request.method, body);
    if (root === "agents" && id && sub === "models") {
      const agent = this.agents.find((candidate) => candidate.id === id);
      if (!agent) return problem(404, "No such agent.");
      return this.roles.agentRoute(request.method, id, agent.model, this.fastModel, body);
    }
    if ((root === "notes" || root === "knowledge") && id && sub === "provenance") {
      const shown = this.provenance.get(id);
      return shown === undefined ? problem(404, "there is no such note") : reply(shown);
    }
    if (root === "agents" && id && sub === "learned") {
      if (subId === "forget" && request.method === "POST") {
        const source = String((body as { source?: unknown }).source ?? "");
        this.forgotSources.push({ agent: id, source });
        this.learned.set(
          id,
          (this.learned.get(id) ?? []).filter((s) => (s as { key?: unknown }).key !== source),
        );
        return reply({ notes: 1, entries: 0 });
      }
      return reply({ sources: this.learned.get(id) ?? [] });
    }
    if (root === "onboarding" && request.method === "GET") return reply(this.onboarding);
    if (root === "onboarding" && request.method === "PUT") {
      Object.assign(this.onboarding, body);
      return reply(this.onboarding);
    }
    const searched = new URLSearchParams(query).get("q") ?? "";
    if (root === "notes") return this.notes.route(request.method, null, id, body, sub, searched);
    if (root === "agents" && id && sub === "notes")
      return this.agents.some((agent) => agent.id === id)
        ? this.notes.route(request.method, id, undefined, body, undefined, searched)
        : problem(404, "No such agent.");
    if (root === "agents" && id === "import" && request.method === "POST")
      return this.teams.importRoute(body);
    if (root === "agents" && id && (sub === "duplicate" || sub === "export"))
      return this.teams.agentRoute(request.method, id, sub, body);
    if (root === "groups") return this.teams.groupRoute(request.method, id, sub, body);
    if (root === "templates" && request.method === "GET")
      return reply({ templates: this.teams.templates });
    if (root === "agents" && id && (sub === "routines" || sub === "heartbeat"))
      return this.routines.agentRoute(request.method, id, sub, body);
    if (root === "agents" && id && (sub === "task" || sub === "tree")) {
      const agent = this.agents.find((candidate) => candidate.id === id);
      if (!agent) return problem(404, "No such agent.");
      return this.work.route(request.method, agent, sub, subId, body) ?? problem(404, "Not found.");
    }
    if (root === "agents" && id && sub === "pin" && request.method === "PUT") {
      const agent = this.agents.find((candidate) => candidate.id === id);
      if (!agent) return problem(404, "No such agent.");
      agent.pinned_at = body.pinned === true ? (agent.pinned_at ?? this.now()) : null;
      return reply({ agent });
    }
    // The person accepts a bot moving here (ADR 0187); the daemon stamps it as theirs.
    if (root === "moves" && id && sub === "accept" && request.method === "PUT") {
      if (typeof body.bot !== "string") return problem(400, "Name the bot.");
      this.acceptedMoves.set(id, body.bot);
      this.acceptances.set(id, body);
      return reply({ accepted: true });
    }
    if (root === "agents" && id && (sub === "move" || sub === "arrival")) {
      const agent = this.agents.find((candidate) => candidate.id === id);
      if (!agent) return problem(404, "No such agent.");
      if (sub === "arrival") {
        agent.arrived = null;
        return { status: 204 };
      }
      if (request.method === "DELETE") {
        agent.move = null;
        return reply({ move: null });
      }
      if (request.method === "GET") return reply({ move: agent.move ?? null });
      if (subId === "check") return reply({ checking: true });
      if (agent.state !== "idle")
        return problem(
          409,
          `${agent.name} is working; it can move once that ends, or once you stop it.`,
        );
      if (typeof body.move !== "string") return problem(400, "Name the move.");
      const to = String(body.to);
      agent.move = {
        id: body.move,
        to: { host: to, name: this.machineNames.get(to) ?? to },
        state: "sending",
        from: this.here ?? "this-mac",
        via: `dev-${this.here ?? "this-mac"}`,
        digest: "a".repeat(64),
        replaces: agent.kind === "main" ? "main" : "bot",
        sent: 3,
        total: 12,
        waiting: false,
        problem: null,
        can_cancel: true,
      };
      return reply({ move: agent.move }, 202);
    }
    if (root === "agents") return this.agentRoute(request.method, id, body, query);
    if (root === "routines" && id) return this.routines.route(request.method, id, sub, body);
    if (root === "connectors")
      return this.connectors.route(request.method, id, sub, body, this.roster());
    if (root === "models" && request.method === "GET")
      return reply({
        endpoints: this.keysPending
          ? this.endpoints.map((endpoint) => ({ ...endpoint, key_set: null, key_source: null }))
          : this.endpoints,
        keys_pending: this.keysPending,
        ...(this.characterAvatars ? { character_avatars: true } : {}),
        presets: this.presets,
        fast_model: this.fastModel,
        new_bot_model: this.newBotModel,
        transcription_model: this.transcriptionModel,
        keychain: this.keychain,
      });
    if (root === "subscriptions" && request.method === "GET")
      return reply({ providers: this.subscriptions, error: null });
    if (root === "endpoints" && id === "local" && request.method === "GET")
      return reply({ servers: this.localServers });
    if (root === "endpoints") return this.endpointRoute(request.method, id, sub, body, query);
    if (root === "keys" && id) return this.keyRoute(request.method, id);
    if (root === "search") return this.search.route(request.method, id, body, this.keychain);
    if (root === "settings" && request.method === "PUT") {
      if ("fast_model" in body)
        this.fastModel = typeof body.fast_model === "string" ? body.fast_model : null;
      if ("new_bot_model" in body)
        this.newBotModel = typeof body.new_bot_model === "string" ? body.new_bot_model : null;
      if ("transcription_model" in body) {
        const model =
          typeof body.transcription_model === "string" ? body.transcription_model : null;
        // As Spade: any `endpoint/model` on a saved endpoint, whatever its facts say.
        const [endpoint, ...rest] = model?.split("/") ?? [];
        if (model !== null && !(rest.join("/") && this.endpoints.some((e) => e.id === endpoint)))
          return problem(400, "The transcription model must be on one of your endpoints.");
        this.transcriptionModel = model;
      }
      return { status: 204 };
    }
    if (root === "main" && id === "host" && request.method === "PUT") {
      const held = this.hostRecord;
      const newer =
        !held ||
        Number(body.version) > Number(held.version) ||
        (Number(body.version) === Number(held.version) && Number(body.at) > Number(held.at));
      if (newer) {
        this.hostRecord = body;
        this.mainEnabled = true;
      }
      return reply({ host: this.hostRecord });
    }
    if (root === "main" && request.method === "GET")
      return reply({
        here: this.here ?? null,
        host: this.hostRecord ?? null,
        shown: this.mainShown(),
        off: this.mainOff,
      });
    if (root === "main") {
      if (body.by === "person") this.mainOff = body.enabled === false;
      else if (!this.hostRecord) this.mainEnabled = body.enabled !== false;
      return { status: 204 };
    }
    if (root === "conversations" && id)
      return this.conversationRoute(request, id, sub, subId, query);
    if (root === "images") {
      const type = id ? this.images.get(id) : undefined;
      return type
        ? { status: 200, body: `bytes of ${id}`, contentType: type }
        : { status: 404, body: "" };
    }
    if (root === "transcriptions" && request.method === "POST")
      return this.transcriptionModel
        ? reply({ text: this.transcript })
        : problem(409, "No transcription model is set.");
    // A stored document or recording: its bytes, as text here.
    if ((root === "documents" || root === "audio") && id && request.method === "GET")
      return {
        status: 200,
        body: `bytes of ${id}`,
        contentType: root === "audio" ? "audio/webm" : "application/octet-stream",
      };
    return problem(404, "Not found.");
  }

  /** The agents `GET /v1/agents` lists, in its order: Spade first (while on), then by activity. */
  private listed(): FakeSpadeAgent[] {
    return this.agents
      .filter((agent) => agent.kind !== "main" || this.mainShown())
      .toSorted(
        (a, b) =>
          Number(b.kind === "main") - Number(a.kind === "main") ||
          b.last_activity - a.last_activity,
      );
  }

  /** The person's message into a conversation, as `POST /conversations/{id}/messages` takes it. */
  private takeMessage(conversation: string, agent: FakeSpadeAgent | undefined, body: Json) {
    const media = mediaOf(body);
    for (const image of (media.images ?? []) as Json[])
      this.images.set(String(image.sha256), String(image.media_type));
    this.store(conversation, { type: "user_message", text: body.text ?? "", ...media });
    if (agent)
      agent.last_message = {
        from: "person",
        text: String(body.text ?? ""),
        at: this.now(),
        from_agent: null,
      };
  }

  private roster() {
    return this.listed().map((agent) => ({ id: agent.id, main: agent.kind === "main" }));
  }

  private agentRoute(
    method: string,
    id: string | undefined,
    body: Json,
    query = "",
  ): FakeSpadeAnswer {
    if (!id && method === "GET")
      return reply({
        agents: this.listed().map((agent) =>
          Object.assign({}, agent, this.work.rosterFields(agent), {
            computer: this.computer.of(agent.id),
            autonomy: this.security.autonomy(agent.id),
          }),
        ),
      });
    // As Spade: the auto-review is the one level; any other is refused.
    if (body.access !== undefined && body.access !== "auto_review")
      return problem(400, "access must be auto_review.");
    if (!id && method === "POST") {
      const avatar = body.avatar as Json | undefined;
      const agent = this.addAgent({
        name: String(body.name ?? ""),
        task: String(body.task ?? ""),
        // As Spade: a new bot with no model named starts on the model for new bots.
        model: String(body.model ?? this.newBotModel ?? ""),
        access: "auto_review",
        ...(avatar?.kind === "image"
          ? { avatar: { kind: "image", sha256: "a".repeat(64) } }
          : avatar?.kind === "character"
            ? { avatar: storedBotFace(repairFace(avatar)) as Json }
            : {}),
      });
      // As Spade: a first message goes with the bot it makes (the new-bot conversation).
      const first = body.first_message as Json | undefined;
      if (first && typeof first === "object") this.takeMessage(agent.conversation, agent, first);
      return reply({ agent }, 201);
    }
    const agent = this.agents.find((candidate) => candidate.id === id);
    if (!agent) return problem(404, "No such agent.");
    if (method === "PATCH") {
      if (agent.kind === "main" && ("name" in body || "avatar" in body))
        return problem(400, "Spade's name and face can't change.");
      for (const key of ["name", "task", "model"] as const)
        if (typeof body[key] === "string") agent[key] = body[key];
      if (body.avatar && typeof body.avatar === "object") {
        const avatar = body.avatar as Json;
        agent.avatar =
          avatar.kind === "character" ? (storedBotFace(repairFace(avatar)) as Json) : avatar;
      }
      return reply({ agent });
    }
    if (method === "DELETE") {
      if (agent.kind === "main") return problem(409, "Spade can't be deleted.");
      // As Spade: a bot with workers asks what becomes of them (ADR 0161).
      const asked = this.work.deleting(agent, new URLSearchParams(query));
      if (asked) return asked;
      this.agents = this.agents.filter((candidate) => candidate !== agent);
      this.notes.forget(agent.id);
      this.knowledge.forget(agent.id);
      return { status: 204 };
    }
    return problem(405, "Not allowed.");
  }

  private workspaceRoute(
    method: string,
    agent: string,
    view: string | undefined,
    query: URLSearchParams,
  ): FakeSpadeAnswer {
    const files = this.files.get(agent) ?? {};
    const path = query.get("path") ?? "";
    if (path.startsWith("/") || path.split("/").includes(".."))
      return problem(400, "paths may not use `..`");
    if (method === "DELETE") {
      if (!path) return problem(422, "the workspace itself cannot be deleted");
      const stale = fakeStale(files, path, query.get("base") ?? undefined);
      if (stale) return stale;
      for (const name of Object.keys(files))
        if (name === path || name.startsWith(`${path}/`)) delete files[name];
      const folders = this.folders.get(agent);
      for (const folder of folders ?? [])
        if (folder === path || folder.startsWith(`${path}/`)) folders?.delete(folder);
      return { status: 204 };
    }
    if (view === "file") {
      const text = files[path];
      if (text === undefined) return problem(404, `${path} does not exist`);
      return reply({
        path,
        size: text.length,
        text,
        unreadable: null,
        revision: fakeFileRevision(text),
      });
    }
    const prefix = path ? `${path}/` : "";
    const entries = new Map<string, Json>();
    for (const [name, text] of Object.entries(files)) {
      if (!name.startsWith(prefix)) continue;
      const [first = "", ...rest] = name.slice(prefix.length).split("/");
      const folder = rest.length > 0;
      entries.set(first, {
        name: first,
        path: `${prefix}${first}`,
        kind: folder ? "folder" : "file",
        size: folder ? 0 : text.length,
        modified_at: null,
      });
    }
    for (const folder of this.folders.get(agent) ?? []) {
      if (!folder.startsWith(prefix)) continue;
      const [first = ""] = folder.slice(prefix.length).split("/");
      if (!entries.has(first))
        entries.set(first, {
          name: first,
          path: `${prefix}${first}`,
          kind: "folder",
          size: 0,
          modified_at: null,
        });
    }
    const list = [...entries.values()].toSorted(
      (a, b) =>
        Number(a.kind !== "folder") - Number(b.kind !== "folder") ||
        String(a.name).localeCompare(String(b.name)),
    );
    return reply({ path, entries: list, truncated: false });
  }

  private proposalRoute(
    method: string,
    agent: string,
    id: string | undefined,
    body: Json,
  ): FakeSpadeAnswer {
    const list = this.proposals.get(agent) ?? [];
    if (!id && method === "GET") return reply({ proposals: list });
    const proposal = list.find((candidate) => candidate.id === id);
    if (!proposal) return problem(404, "no such proposal");
    if (proposal.state !== "open") return problem(409, "this proposal was already answered");
    proposal.state = body.save === true ? "saved" : "discarded";
    return reply({ proposal });
  }

  private endpointRoute(
    method: string,
    id: string | undefined,
    sub: string | undefined,
    body: Json,
    query: string,
  ): FakeSpadeAnswer {
    if (!id && method === "POST") {
      const endpoint = {
        id: String(body.name ?? "endpoint")
          .toLowerCase()
          .replaceAll(/\W+/g, "-"),
        name: body.name,
        format: body.format,
        base_url: body.base_url,
        header_names: Object.keys((body.headers as Json | undefined) ?? {}),
        session_header: body.session_header ?? null,
        needs_key: body.needs_key !== false,
        key_set: false,
        key_source: null,
        // A preset's models come with an endpoint made from it.
        models: (
          (this.presets.find((preset) => preset.id === body.preset)?.models as
            | Json[]
            | undefined) ?? []
        ).map((model) => Object.assign({}, model, { source: "preset" })),
      };
      this.endpoints.push(endpoint);
      return reply({ endpoint }, 201);
    }
    const endpoint = this.endpoints.find((candidate) => candidate.id === id);
    if (!endpoint) return problem(404, "No such endpoint.");
    if (sub === "models") {
      if (method === "GET") {
        const live = this.liveModels.get(String(id));
        if (typeof live === "number") return problem(live, "The endpoint didn't answer.");
        return reply({ models: live ?? [] });
      }
      const models = (endpoint.models as Json[]) ?? [];
      if (method === "POST") {
        endpoint.models = [
          ...models.filter((model) => model.id !== body.id),
          { ...body, source: "typed" },
        ];
        return reply({ endpoint });
      }
      if (method === "DELETE") {
        const model = new URLSearchParams(query).get("id");
        endpoint.models = models.filter((candidate) => candidate.id !== model);
        return { status: 204 };
      }
    }
    if (method === "PATCH") {
      Object.assign(endpoint, body);
      return reply({ endpoint });
    }
    if (method === "DELETE") {
      const users = this.agents.filter((agent) => agent.model.startsWith(`${String(id)}/`));
      if (users.length)
        return problem(409, `${users.map((agent) => agent.name).join(", ")} use this endpoint.`);
      this.endpoints = this.endpoints.filter((candidate) => candidate !== endpoint);
      return { status: 204 };
    }
    return problem(405, "Not allowed.");
  }

  private keyRoute(method: string, id: string): FakeSpadeAnswer {
    const endpoint = this.endpoints.find((candidate) => candidate.id === id);
    if (!endpoint) return problem(404, "No such endpoint.");
    if (!this.keychain) return problem(503, "This machine has no keychain.");
    if (this.keyFailure) return problem(this.keyFailure, "The keychain refused the key.");
    endpoint.key_set = method === "PUT";
    endpoint.key_source = method === "PUT" ? "keychain" : null;
    return { status: 204 };
  }

  /**
   * `PUT /v1/conversations/{id}/seen`: the cursor moves forward to `seq` (the last event when
   * absent, never past it), the bot's or group's `unseen` clears, and the live stream says so.
   */
  private markSeen(id: string, list: readonly Stored[], raw: string | undefined): FakeSpadeAnswer {
    const body = raw ? (JSON.parse(raw) as Json) : {};
    const last = list.at(-1)?.seq ?? 0;
    const asked = typeof body.seq === "number" ? Math.min(body.seq, last) : last;
    const owner =
      this.agents.find((candidate) => candidate.conversation === id) ??
      this.teams.groups.find((candidate) => candidate.conversation === id);
    if (!owner) return problem(404, "No such conversation.");
    const seq = Math.max(owner.seen_seq ?? 0, asked);
    owner.seen_seq = seq;
    owner.unseen = false;
    this.spade.emit(`/v1/conversations/${id}/live`, "seen", { seq });
    return reply({ seen_seq: seq });
  }

  private conversationRoute(
    request: FakeSpadeRequest,
    id: string,
    sub: string | undefined,
    subId: string | undefined,
    query: string,
  ): FakeSpadeAnswer {
    const list = this.events.get(id);
    if (!list) return problem(404, "No such conversation.");
    const agent = this.agents.find((candidate) => candidate.conversation === id);
    if (sub === "seen" && request.method === "PUT") return this.markSeen(id, list, request.body);
    if (sub === "events") {
      const after = Number(new URLSearchParams(query).get("after") ?? 0);
      return reply(list.filter((stored) => stored.seq > after));
    }
    if (sub === "messages" && request.method === "POST") {
      const body = request.body ? (JSON.parse(request.body) as Json) : {};
      this.takeMessage(id, agent, body);
      return reply({ seq: list.length }, 202);
    }
    if (sub === "questions" && subId && request.method === "POST") {
      const body = request.body ? (JSON.parse(request.body) as Json) : {};
      const refusal = this.refuseQuestion;
      if (refusal) {
        this.refuseQuestion = undefined;
        return problem(refusal.status, refusal.error);
      }
      const events = list.map((stored) => stored.event);
      const card = events.find(
        (event) => event.type === "question_asked" && event.call_id === subId,
      );
      const asked = card !== undefined;
      const questions = Array.isArray(card?.questions) ? card.questions.length : 1;
      const settled = events.some(
        (event) =>
          (event.type === "question_answered" || event.type === "question_dismissed") &&
          event.call_id === subId,
      );
      const deferred = events.some(
        (event) => event.type === "question_deferred" && event.call_id === subId,
      );
      if (!asked || settled || (body.defer === true && deferred))
        return problem(409, "That question isn't open.");
      if (body.defer !== true && body.dismiss !== true && !Array.isArray(body.answers))
        return problem(400, "Send exactly one of answers, defer or dismiss.");
      const settle = () => {
        const put = (event: Json) =>
          this.missQuestionSettles ? this.keep(id, event) : this.store(id, event);
        if (body.defer === true) put({ type: "question_deferred", call_id: subId });
        else if (body.dismiss === true)
          put({
            type: "question_dismissed",
            call_id: subId,
            late: deferred || undefined,
          });
        else
          put({
            type: "question_answered",
            call_id: subId,
            answers: body.answers,
            late: deferred || undefined,
          });
        if (agent) {
          const later =
            (agent.questions_for_later ?? 0) +
            (body.defer === true ? questions : deferred ? -questions : 0);
          agent.questions_for_later = Math.max(0, later);
          if (agent.waiting_for === "question") this.status(agent, "idle", null);
        }
      };
      if (this.heldSettles) this.heldSettles.push(settle);
      else settle();
      return reply({}, 202);
    }
    if (sub === "approvals" && subId && request.method === "POST") {
      const body = request.body ? (JSON.parse(request.body) as Json) : {};
      const asked = list.findLast(
        (stored) => stored.event.type === "approval_requested" && stored.event.call_id === subId,
      );
      this.store(id, {
        type: "approval_answered",
        reply: asked?.event.reply ?? "",
        call_id: subId,
        allowed: body.allowed === true,
        always: body.always === true,
      });
      if (agent?.task_state?.status === "blocked_on_person")
        agent.task_state = { status: "working" };
      if (agent) this.status(agent, "working", null);
      return reply({});
    }
    if (sub === "retry" && request.method === "POST") {
      // Try again: only the last reply, while it failed; the new reply opens in its place.
      const body = request.body ? (JSON.parse(request.body) as Json) : {};
      const last = list.findLast((stored) => stored.event.type === "reply_started");
      const failed = list.some(
        (stored) => stored.event.type === "reply_failed" && stored.event.reply === body.reply,
      );
      if (!failed || last?.event.reply !== body.reply)
        return problem(409, "only the last reply can be tried again, and only when it failed");
      this.store(id, { type: "reply_retried", reply: body.reply });
      this.store(id, { type: "reply_started", reply: `${String(body.reply)}~again` });
      if (agent) this.status(agent, "working", "Thinking");
      return reply({}, 202);
    }
    if (sub === "stop" && request.method === "POST") {
      const open = list.findLast((stored) => stored.event.type === "reply_started");
      if (open) this.store(id, { type: "reply_stopped", reply: open.event.reply, text: "" });
      if (agent) this.status(agent, "idle", null);
      return reply({});
    }
    return problem(404, "Not found.");
  }
}

/** What Spade names an upload by: the SHA-256 of its bytes, and their count. */
function uploadIdentity(data: unknown) {
  let bytes: Uint8Array;
  try {
    bytes = base64Bytes(String(data));
  } catch {
    bytes = new TextEncoder().encode(String(data));
  }
  return { sha256: sha256Hex(bytes), bytes: bytes.length };
}

/** A sent message's images, documents and recording, stored as Spade stores them (ADR 0134). */
function mediaOf(body: Json): Json {
  const images = Array.isArray(body.images) ? (body.images as Json[]) : [];
  const files = Array.isArray(body.files) ? (body.files as Json[]) : [];
  const voice = body.voice as Json | undefined;
  return {
    ...(images.length
      ? {
          images: images.map((image) => {
            const { sha256, bytes } = uploadIdentity(image.data);
            return { sha256, media_type: "image/png", bytes };
          }),
        }
      : {}),
    ...(files.length
      ? {
          documents: files.map((file) => {
            const { sha256, bytes } = uploadIdentity(file.data);
            const name = String(file.name);
            const pdf = name.endsWith(".pdf");
            const media_type = pdf ? "application/pdf" : "application/octet-stream";
            return { sha256, name, media_type, bytes, chars: 0, cut: false, view: "" };
          }),
        }
      : {}),
    ...(voice
      ? {
          voice: {
            ...uploadIdentity(voice.data),
            media_type: String(voice.media_type),
          },
        }
      : {}),
  };
}
