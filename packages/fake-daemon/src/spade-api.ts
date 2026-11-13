import type { FakeSpade, FakeSpadeAnswer, FakeSpadeRequest, FakeSpadeServer } from "./spade.ts";
import { FakeSpadeComputer, fakeFileRevision } from "./spade-computer.ts";
import { FakeSpadeConnectors } from "./spade-connectors-api.ts";
import { FakeSpadeNotes } from "./spade-notes.ts";
import { FakeSpadeSearch } from "./spade-search.ts";
import { FakeSpadeOversight, type FakeSpadeSpending } from "./spade-oversight.ts";
import { FakeSpadeRoutines } from "./spade-routines.ts";
import { base64Bytes, sha256Hex } from "./sha256.ts";
import { FakeSpadeTeams } from "./spade-teams.ts";
import { faceForId, repairFace, storedBotFace } from "@ace/ui-core/bot-face";

/*
 * A stateful stand-in for Spade's local API (ADR 0126, 0127), in Spade's own JSON: agents with
 * one conversation each, endpoints and their models, stored events and live streams. Tests and
 * the fake app drive it (`reply`, `status`, `ask`) and read what the app sent (`requests`).
 */

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
  state: "idle" | "working" | "waiting";
  waiting_for: "approval" | "question" | null;
  status: string | null;
  /** Why its latest reply on a subscription failed (ADR 0133). */
  problem?: string | null;
  last_message: {
    from: "person" | "agent";
    text: string;
    at: number;
    from_agent: { id: string; name: string } | null;
  } | null;
  /** Its spend and caps (ADR 0135); left out, as an older Spade does, until set. */
  spending?: FakeSpadeSpending;
  review?: boolean | null;
}

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
  /** True: the keychain hasn't answered (a prompt is open), so keys read as not known yet. */
  keysPending = false;
  characterAvatars = true;
  /** `PUT /v1/main`: false leaves the main agent out of the list, as Spade does. */
  mainEnabled = true;
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
  /** What the bots remember, their own and the shared ones (ADR 0128). */
  readonly notes: FakeSpadeNotes;
  /** Every request the app sent, in order. */
  readonly requests: FakeSpadeRequest[] = [];
  /** The person's connected apps and each bot's allow list (ADR 0131). */
  readonly connectors = new FakeSpadeConnectors();
  /** Caps, the review and the activity log (ADR 0135). */
  readonly oversight = new FakeSpadeOversight();
  /** Web search settings: the SearXNG address and whether a Brave key is set. */
  readonly search = new FakeSpadeSearch();
  private readonly events = new Map<string, Stored[]>();
  private sequence = 0;
  private readonly spade: FakeSpade;
  private readonly now: () => number;
  /** Each bot's routines and heartbeat (ADR 0129). */
  readonly routines: FakeSpadeRoutines;
  /** Groups, templates, duplicate, export and import (ADR 0132). */
  readonly teams: FakeSpadeTeams;

  constructor(spade: FakeSpade, now: () => number = () => 1_000) {
    this.spade = spade;
    this.now = now;
    this.notes = new FakeSpadeNotes(now);
    this.routines = new FakeSpadeRoutines(now);
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
    const list = this.events.get(conversation) ?? [];
    const stored = { seq: list.length + 1, at: this.now(), event };
    list.push(stored);
    this.events.set(conversation, list);
    this.spade.emit(`/v1/conversations/${conversation}/live`, "stored", stored);
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

  /** The bodies the app sent to `method path`, parsed. */
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
    if (root === "agents" && id && sub === "workspace")
      return this.workspaceRoute(request.method, id, subId, new URLSearchParams(query));
    if (root === "agents" && id && sub === "skill-proposals")
      return this.proposalRoute(request.method, id, subId, body);
    if (root === "agents" && id && sub === "connectors") {
      const agent = this.agents.find((candidate) => candidate.id === id);
      if (!agent) return problem(404, "No such agent.");
      return this.connectors.agentRoute(request.method, id, agent.kind === "main", body);
    }
    if (root === "oversight") return this.oversight.route(request.method, body);
    if (root === "agents" && id && (sub === "oversight" || sub === "activity")) {
      const agent = this.agents.find((candidate) => candidate.id === id);
      if (!agent) return problem(404, "No such agent.");
      return sub === "activity"
        ? this.oversight.activityRoute(id, new URLSearchParams(query))
        : this.oversight.agentRoute(request.method, agent, body);
    }
    if (root === "notes") return this.notes.route(request.method, null, id, body, sub);
    if (root === "agents" && id && sub === "notes")
      return this.agents.some((agent) => agent.id === id)
        ? this.notes.route(request.method, id, undefined, body)
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
    if (root === "agents") return this.agentRoute(request.method, id, body);
    if (root === "routines" && id) return this.routines.route(request.method, id, sub, body);
    if (root === "connectors") return this.connectors.route(request.method, id, sub, body);
    if (root === "models" && request.method === "GET")
      return reply({
        endpoints: this.keysPending
          ? this.endpoints.map((endpoint) => ({ ...endpoint, key_set: null, key_source: null }))
          : this.endpoints,
        keys_pending: this.keysPending,
        ...(this.characterAvatars ? { character_avatars: true } : {}),
        presets: this.presets,
        fast_model: this.fastModel,
        transcription_model: this.transcriptionModel,
        keychain: this.keychain,
      });
    if (root === "subscriptions" && request.method === "GET")
      return reply({ providers: this.subscriptions, error: null });
    if (root === "endpoints") return this.endpointRoute(request.method, id, sub, body, query);
    if (root === "keys" && id) return this.keyRoute(request.method, id);
    if (root === "search") return this.search.route(request.method, id, body, this.keychain);
    if (root === "settings" && request.method === "PUT") {
      if ("fast_model" in body)
        this.fastModel = typeof body.fast_model === "string" ? body.fast_model : null;
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
    if (root === "main") {
      this.mainEnabled = body.enabled !== false;
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

  private agentRoute(method: string, id: string | undefined, body: Json): FakeSpadeAnswer {
    if (!id && method === "GET")
      return reply({
        agents: this.agents
          .filter((agent) => agent.kind !== "main" || this.mainEnabled)
          .toSorted(
            (a, b) =>
              Number(b.kind === "main") - Number(a.kind === "main") ||
              b.last_activity - a.last_activity,
          )
          .map((agent) => Object.assign({}, agent, { computer: this.computer.of(agent.id) })),
      });
    if (!id && method === "POST") {
      const avatar = body.avatar as Json | undefined;
      const agent = this.addAgent({
        name: String(body.name ?? ""),
        task: String(body.task ?? ""),
        model: String(body.model ?? ""),
        ...(avatar?.kind === "image"
          ? { avatar: { kind: "image", sha256: "a".repeat(64) } }
          : avatar?.kind === "character"
            ? { avatar: storedBotFace(repairFace(avatar)) as Json }
            : {}),
      });
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
      this.agents = this.agents.filter((candidate) => candidate !== agent);
      this.notes.forget(agent.id);
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
    if (sub === "events") {
      const after = Number(new URLSearchParams(query).get("after") ?? 0);
      return reply(list.filter((stored) => stored.seq > after));
    }
    if (sub === "messages" && request.method === "POST") {
      const body = request.body ? (JSON.parse(request.body) as Json) : {};
      const media = mediaOf(body);
      for (const image of (media.images ?? []) as Json[])
        this.images.set(String(image.sha256), String(image.media_type));
      this.store(id, { type: "user_message", text: body.text ?? "", ...media });
      if (agent)
        agent.last_message = {
          from: "person",
          text: String(body.text ?? ""),
          at: this.now(),
          from_agent: null,
        };
      return reply({ seq: list.length }, 202);
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
      if (agent) this.status(agent, "working", null);
      return reply({});
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
