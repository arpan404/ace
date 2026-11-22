import type { FakeSpadeAnswer } from "./spade.ts";
import { FakeSpadePermissions, isFakePermissionKey } from "./spade-permissions.ts";

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

export type FakeSpadeCommands = "sandboxed" | "outside";

/** How a bot decides (ADR 0163, amendment 2). */
export type FakeSpadeAutonomy = "auto_review" | "full_access";

const autonomies: ReadonlySet<unknown> = new Set(["auto_review", "full_access"]);

export interface FakeSpadeBotSecurity {
  /** null inherits the machine's. */
  commands: FakeSpadeCommands | null;
  /** null inherits the machine's. */
  autonomy: FakeSpadeAutonomy | null;
  full_access_confirmed: boolean;
  network: FakeSpadeNetworkPolicy | null;
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
  /** What every bot inherits (ADR 0171). */
  botDefaults: {
    commands: FakeSpadeCommands;
    autonomy: FakeSpadeAutonomy;
    network: FakeSpadeNetworkPolicy;
    plugin_network: FakeSpadeNetworkPolicy;
  } = {
    commands: "sandboxed",
    autonomy: "auto_review",
    network: { mode: "allow_list", allow: [], dropped: [] },
    plugin_network: { mode: "open", allow: [], dropped: [] },
  };
  toolchainsFound: string[] = [];
  /** Bots' Permissions and the apps they never use (ADR 0171, amendment 7). */
  readonly permissions = new FakeSpadePermissions();
  /** Each bot's settings, as Spade stores `security:<bot>`. */
  readonly bots = new Map<string, FakeSpadeBotSecurity>();
  /** Each bot's egress lines, oldest first, in Spade's JSON. */
  readonly egress = new Map<string, Json[]>();
  /** Each bot's checkpoints, newest first. */
  readonly checkpoints = new Map<string, FakeSpadeCheckpoint[]>();
  /**
   * What undoing from a step would put back, by bot then the step's position, as Spade answers
   * `GET …/checkpoints/undo?seq=` (`{checkpoint, changes}`); a position not set answers 404.
   */
  readonly undoPreviews = new Map<string, Map<number, Json>>();
  /** Checkpoints restored, by bot, in order. */
  readonly restored = new Map<string, string[]>();
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
        commands: null,
        autonomy: null,
        full_access_confirmed: false,
        network: null,
        plugin_network: null,
        toolchains: [],
        grants: [],
      };
      this.bots.set(id, settings);
    }
    return settings;
  }

  /** How a bot decides: its own, else the machine's (workers aren't modelled here). */
  autonomy(id: string): FakeSpadeAutonomy {
    return this.bots.get(id)?.autonomy ?? this.botDefaults.autonomy;
  }

  machineRoute(method: string, sub?: string, body: Json = {}): FakeSpadeAnswer {
    if (method === "PUT" && sub === "permissions") {
      if (!isFakePermissionKey(body.key) || typeof body.on !== "boolean")
        return problem(400, "There is no such permission.");
      if (body.on) {
        const refused = this.permissions.refusal();
        if (refused) return refused;
      }
      const key = body.key;
      if (key === "commands") this.botDefaults.commands = body.on ? "outside" : "sandboxed";
      else if (key === "network")
        this.botDefaults.network = {
          ...this.botDefaults.network,
          mode: body.on ? "open" : "allow_list",
        };
      else if (this.permissions.isKept(key)) this.permissions.defaults[key] = body.on;
      return this.machineView();
    }
    if (method === "PUT" && sub === "never-apps") {
      const apps = Array.isArray(body.apps) ? body.apps.map((app) => String(app).trim()) : [];
      const next = [...new Set(apps.filter(Boolean))];
      const drops = this.permissions.neverApps.some((app) => !next.includes(app));
      const refused = drops ? this.permissions.refusal() : undefined;
      if (refused) return refused;
      this.permissions.neverApps = next;
      return this.machineView();
    }
    if (method === "PUT" && sub === "autonomy") {
      if (body.autonomy !== "auto_review" && body.autonomy !== "full_access")
        return problem(422, `unknown variant \`${String(body.autonomy)}\``);
      this.botDefaults.autonomy = body.autonomy;
      return this.machineView();
    }
    if (method === "PUT" && sub === "commands") {
      if (body.commands !== "sandboxed" && body.commands !== "outside")
        return problem(400, `unknown variant \`${String(body.commands)}\``);
      // Loosening is the person's alone, as every route that loosens is (ADR 0171, amendment 7).
      if (body.commands === "outside" && this.botDefaults.commands !== "outside") {
        const refused = this.permissions.refusal();
        if (refused) return refused;
      }
      this.botDefaults.commands = body.commands;
      return this.machineView();
    }
    if (method === "PUT" && (sub === "network" || sub === "plugin-network")) {
      const policy = this.policyFrom(body);
      if (typeof policy === "string") return problem(400, policy);
      if (sub === "network") this.botDefaults.network = policy;
      else this.botDefaults.plugin_network = policy;
      return this.machineView();
    }
    if (method !== "GET" || sub !== undefined) return problem(405, "Not allowed.");
    return this.machineView();
  }

  private machineView(): FakeSpadeAnswer {
    return reply({
      bots: this.botDefaults,
      sandbox: this.sandbox,
      proxy: this.proxy,
      contained: this.contains(),
      defaults: this.defaults,
      toolchains_found: this.toolchainsFound,
      permissions: this.permissions.machineView({
        commands: this.botDefaults.commands === "outside",
        network: this.botDefaults.network.mode === "open",
      }),
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
    if (root === "checkpoints" && sub === "undo" && method === "GET") {
      const preview = this.undoPreviews.get(agent.id)?.get(Number(query.get("seq")));
      return preview === undefined
        ? problem(404, "no checkpoint was kept from before this step")
        : reply(preview);
    }
    if (root === "checkpoints") return this.checkpointRoute(method, agent, sub, action);
    return problem(404, "Not found.");
  }

  private view(id: string) {
    const settings = this.bot(id);
    return {
      contained: this.contains(),
      commands: settings.commands ?? this.botDefaults.commands,
      autonomy: this.autonomy(id),
      full_access_confirmed: settings.full_access_confirmed,
      own: {
        commands: settings.commands !== null,
        autonomy: settings.autonomy !== null,
        network: settings.network !== null,
        plugin_network: settings.plugin_network !== null,
      },
      network: settings.network ?? this.botDefaults.network,
      plugin_network: settings.plugin_network ?? this.botDefaults.plugin_network,
      toolchains: settings.toolchains,
      grants: settings.grants,
      effective_grants: settings.grants,
      folders: settings.grants
        .filter((grant) => grant.kind === "folder")
        .map((grant) => ({ grant: grant.id, path: grant.path, write: grant.write === true })),
      permissions: this.permissions.view(id, {
        commands: [
          (settings.commands ?? this.botDefaults.commands) === "outside",
          settings.commands !== null,
        ],
        network: [
          (settings.network ?? this.botDefaults.network).mode === "open",
          settings.network !== null,
        ],
      }),
    };
  }

  /** A policy body as Spade checks it; the refusal's words when it is wrong. */
  private policyFrom(body: Json): FakeSpadeNetworkPolicy | string {
    const mode = body.mode ?? "allow_list";
    if (mode !== "off" && mode !== "allow_list" && mode !== "open")
      return `unknown variant \`${String(mode)}\``;
    const allow = (Array.isArray(body.allow) ? body.allow : []).map((each) =>
      String(each).trim().toLowerCase(),
    );
    const wrong = allow.find((entry) => !entryForm.test(entry));
    if (wrong !== undefined)
      return `${wrong} is not a host, *.host or host:port (no scheme, path or other wildcard)`;
    const dropped = (Array.isArray(body.dropped) ? body.dropped : []).map(String);
    const unknown = dropped.find((name) => !this.defaults.includes(name));
    if (unknown !== undefined) return `${unknown} is not one of the defaults`;
    return { mode, allow: [...new Set(allow)], dropped };
  }

  private securityRoute(
    method: string,
    id: string,
    sub: string | undefined,
    query: URLSearchParams,
    body: Json,
  ): FakeSpadeAnswer {
    if (sub === undefined && method === "GET") return reply(this.view(id));
    if (sub === "permissions" && method === "PUT") return this.permissionRoute(id, body);
    if (sub === "commands" && method === "PUT") {
      const commands = body.commands;
      if (commands !== null && commands !== "sandboxed" && commands !== "outside")
        return problem(400, `unknown variant \`${String(commands)}\``);
      if (commands === "outside" && this.bot(id).commands !== "outside") {
        const refused = this.permissions.refusal();
        if (refused) return refused;
      }
      this.bot(id).commands = commands;
      return reply(this.view(id));
    }
    if (sub === "autonomy" && method === "PUT") {
      const autonomy = body.autonomy;
      if (autonomy !== null && !autonomies.has(autonomy))
        return problem(422, `unknown variant \`${String(autonomy)}\``);
      const settings = this.bot(id);
      settings.autonomy = autonomy as FakeSpadeAutonomy | null;
      if (autonomy === "full_access") settings.full_access_confirmed = true;
      return reply(this.view(id));
    }
    if ((sub === "network" || sub === "plugin-network") && method === "DELETE") {
      this.bot(id)[sub === "network" ? "network" : "plugin_network"] = null;
      return reply(this.view(id));
    }
    if ((sub === "network" || sub === "plugin-network") && method === "PUT") {
      const policy = this.policyFrom(body);
      if (typeof policy === "string") return problem(400, policy);
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

  /** One of a bot's switches; a raise is refused without the person's standing. */
  private permissionRoute(id: string, body: Json): FakeSpadeAnswer {
    const key = body.key;
    const on = body.on ?? null;
    if (!isFakePermissionKey(key) || (on !== null && typeof on !== "boolean"))
      return problem(400, "There is no such permission.");
    const before = this.view(id).permissions.on[key];
    const settings = this.bot(id);
    const undo = { commands: settings.commands, network: settings.network };
    const own = { ...this.permissions.own(id) };
    if (key === "commands") settings.commands = on === null ? null : on ? "outside" : "sandboxed";
    else if (key === "network")
      settings.network =
        on === null
          ? null
          : { ...(settings.network ?? this.botDefaults.network), mode: on ? "open" : "allow_list" };
    else if (this.permissions.isKept(key)) this.permissions.set(id, key, on);
    const refused =
      !before && this.view(id).permissions.on[key] ? this.permissions.refusal() : undefined;
    if (refused) {
      settings.commands = undo.commands;
      settings.network = undo.network;
      this.permissions.bots.set(id, own);
      return refused;
    }
    return reply(this.view(id));
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
      this.restored.set(agent.id, [...(this.restored.get(agent.id) ?? []), checkpoint]);
      const saved = { id: `cp${++this.next}`, at: this.now(), reason: "before_restore" };
      this.checkpoints.set(agent.id, [saved, ...list]);
      return reply({ restored: checkpoint, saved });
    }
    return problem(405, "Not allowed.");
  }
}
