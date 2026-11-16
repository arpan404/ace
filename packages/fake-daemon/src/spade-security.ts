import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * The security part of the fake Spade API (ADR 0167, spade/docs/security.md), in the shapes of
 * spade/crates/spade-server/src/api/security.rs: the machine's sandbox, and per bot its network
 * policies, toolchains, grants, consented folders, egress log and checkpoints. A test sets the
 * sandbox, the log and the checkpoints; the fake never copies a workspace or proxies a byte.
 */

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => reply({ error }, status);

/** A few of Spade's defaults (`spade_sandbox::egress::DEFAULTS`), enough for a page to list. */
export const fakeSpadeNetworkDefaults = [
  "registry.npmjs.org",
  "pypi.org",
  "crates.io",
  "github.com",
  "api.github.com",
];

export interface FakeSpadeNetworkPolicy {
  mode: "off" | "allow_list" | "open";
  allow: string[];
  dropped: string[];
}

export interface FakeSpadeGrant extends Json {
  id: string;
  kind: string;
  by: string;
  created_at: number;
}

export interface FakeSpadeCheckpoint {
  id: string;
  at: number;
  reason: string;
}

export interface FakeSpadeBotSecurity {
  network: FakeSpadeNetworkPolicy;
  plugin_network: FakeSpadeNetworkPolicy | null;
  toolchains: string[];
  grants: FakeSpadeGrant[];
}

/** What the restore route needs to know about a bot, as Spade checks it. */
export interface FakeSpadeSecured {
  id: string;
  state: string;
}

const RESERVED = "the bot's workspace is being restored from a checkpoint";

/** `host`, `*.host` or either with `:port`; no scheme, path or other wildcard. */
const entryForm =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$|^\[[0-9a-f:.]+\](?::\d{1,5})?$/;

export class FakeSpadeSecurity {
  sandbox = {
    platform: "macos",
    mechanism: "seatbelt",
    files: "contained",
    network: "contained",
    reason: null as string | null,
  };
  proxy = { running: true, problem: null as string | null };
  defaults = [...fakeSpadeNetworkDefaults];
  toolchainsFound: string[] = [];
  /** Each bot's settings, as Spade stores `security:<bot>`. */
  readonly bots = new Map<string, FakeSpadeBotSecurity>();
  /** Each bot's egress lines, oldest first, in Spade's JSON. */
  readonly egress = new Map<string, Json[]>();
  /** Each bot's checkpoints, newest first. */
  readonly checkpoints = new Map<string, FakeSpadeCheckpoint[]>();
  /** Bots whose workspace is being restored: another restore answers 409. */
  readonly reserved = new Set<string>();
  /** Bots whose services are running: a restore answers 409. */
  readonly servicesRunning = new Set<string>();
  private next = 0;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Whether a bot's run is contained here: files and network held, and the proxy listening. */
  contains(): boolean {
    return (
      this.sandbox.files === "contained" &&
      this.sandbox.network === "contained" &&
      this.proxy.running
    );
  }

  /** A bot's settings, the defaults when none are stored. */
  bot(id: string): FakeSpadeBotSecurity {
    let settings = this.bots.get(id);
    if (!settings) {
      settings = {
        network: { mode: "allow_list", allow: [], dropped: [] },
        plugin_network: null,
        toolchains: [],
        grants: [],
      };
      this.bots.set(id, settings);
    }
    return settings;
  }

  machineRoute(method: string): FakeSpadeAnswer {
    if (method !== "GET") return problem(405, "Not allowed.");
    return reply({
      sandbox: this.sandbox,
      proxy: this.proxy,
      contained: this.contains(),
      defaults: this.defaults,
      toolchains_found: this.toolchainsFound,
    });
  }

  /**
   * `/agents/{id}/security[/…]`, `/agents/{id}/grants[/…]` and `/agents/{id}/checkpoints[/…]`;
   * `agent` undefined for a bot Spade doesn't have.
   */
  agentRoute(
    method: string,
    agent: FakeSpadeSecured | undefined,
    rest: string[],
    query: URLSearchParams,
    body: Json,
  ): FakeSpadeAnswer {
    if (!agent) return problem(404, "there is no such bot");
    const [root, sub, action] = rest;
    if (root === "security") return this.securityRoute(method, agent.id, sub, query, body);
    if (root === "grants") return this.grantsRoute(method, agent.id, sub, body);
    if (root === "checkpoints") return this.checkpointRoute(method, agent, sub, action);
    return problem(404, "Not found.");
  }

  private view(id: string) {
    const settings = this.bot(id);
    return {
      contained: this.contains(),
      network: settings.network,
      plugin_network: settings.plugin_network ?? { mode: "open", allow: [], dropped: [] },
      toolchains: settings.toolchains,
      grants: settings.grants,
      effective_grants: settings.grants,
      folders: settings.grants
        .filter((grant) => grant.kind === "folder")
        .map((grant) => ({ grant: grant.id, path: grant.path, write: grant.write === true })),
    };
  }

  private securityRoute(
    method: string,
    id: string,
    sub: string | undefined,
    query: URLSearchParams,
    body: Json,
  ): FakeSpadeAnswer {
    if (sub === undefined && method === "GET") return reply(this.view(id));
    if ((sub === "network" || sub === "plugin-network") && method === "PUT") {
      const mode = body.mode ?? "allow_list";
      if (mode !== "off" && mode !== "allow_list" && mode !== "open")
        return problem(400, `unknown variant \`${String(mode)}\``);
      const known: FakeSpadeNetworkPolicy["mode"] = mode;
      const allow = (Array.isArray(body.allow) ? body.allow : []).map((each) =>
        String(each).trim().toLowerCase(),
      );
      const wrong = allow.find((entry) => !entryForm.test(entry));
      if (wrong !== undefined)
        return problem(
          400,
          `${wrong} is not a host, *.host or host:port (no scheme, path or other wildcard)`,
        );
      const dropped = (Array.isArray(body.dropped) ? body.dropped : []).map(String);
      const unknown = dropped.find((name) => !this.defaults.includes(name));
      if (unknown !== undefined) return problem(400, `${unknown} is not one of the defaults`);
      const policy = { mode: known, allow: [...new Set(allow)], dropped };
      const settings = this.bot(id);
      if (sub === "network") settings.network = policy;
      else settings.plugin_network = policy;
      return reply(this.view(id));
    }
    if (sub === "toolchains" && method === "PUT") {
      const list = Array.isArray(body.toolchains) ? body.toolchains.map(String) : [];
      const relative = list.find((path) => !path.startsWith("/"));
      if (relative !== undefined) return problem(400, `${relative} is not an absolute folder`);
      this.bot(id).toolchains = list;
      return reply(this.view(id));
    }
    if (sub === "egress" && method === "GET") {
      const limit = Math.min(5_000, Math.max(1, Number(query.get("limit") ?? 200) || 200));
      return reply({ entries: (this.egress.get(id) ?? []).slice(-limit) });
    }
    return problem(405, "Not allowed.");
  }

  private grantsRoute(
    method: string,
    id: string,
    grant: string | undefined,
    body: Json,
  ): FakeSpadeAnswer {
    const settings = this.bot(id);
    if (grant === undefined && method === "GET")
      return reply({ grants: settings.grants, effective: settings.grants });
    if (grant === undefined && method === "POST") {
      const kind = String(body.kind ?? "");
      if (!["folder", "tool", "git_push", "pr_comment"].includes(kind))
        return problem(400, `unknown variant \`${kind}\``);
      if (kind === "folder" && !String(body.path ?? "").startsWith("/"))
        return problem(400, "the folder must be an absolute path");
      const made: FakeSpadeGrant = {
        ...body,
        ...(kind === "folder" ? { write: body.write === true } : {}),
        id: `gr${++this.next}`,
        kind,
        by: "person",
        created_at: this.now(),
      };
      settings.grants.push(made);
      return reply({ grant: made }, 201);
    }
    if (grant !== undefined && method === "DELETE") {
      const before = settings.grants.length;
      settings.grants = settings.grants.filter((each) => each.id !== grant);
      return settings.grants.length === before
        ? problem(404, "there is no such grant")
        : { status: 204 };
    }
    return problem(405, "Not allowed.");
  }

  private checkpointRoute(
    method: string,
    agent: FakeSpadeSecured,
    checkpoint: string | undefined,
    action: string | undefined,
  ): FakeSpadeAnswer {
    const list = this.checkpoints.get(agent.id) ?? [];
    if (checkpoint === undefined && method === "GET")
      return reply({ checkpoints: list, keep: 20, longest_days: 7, every_seconds: 60 });
    if (checkpoint === undefined && method === "POST") {
      const taken = { id: `cp${++this.next}`, at: this.now(), reason: "person" };
      this.checkpoints.set(agent.id, [taken, ...list]);
      return reply({ checkpoint: taken }, 201);
    }
    if (checkpoint !== undefined && action === "restore" && method === "POST") {
      if (this.reserved.has(agent.id)) return problem(409, RESERVED);
      if (agent.state === "working")
        return problem(409, "the bot is working; stop it before restoring a checkpoint");
      if (this.servicesRunning.has(agent.id))
        return problem(
          409,
          "the bot's services are running; stop them before restoring a checkpoint",
        );
      if (!list.some((each) => each.id === checkpoint)) return problem(404, "there is no such bot");
      const saved = { id: `cp${++this.next}`, at: this.now(), reason: "before_restore" };
      this.checkpoints.set(agent.id, [saved, ...list]);
      return reply({ restored: checkpoint, saved });
    }
    return problem(405, "Not allowed.");
  }
}
