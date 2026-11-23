import {
  parseSpadeAgent,
  parseSpadeBotRoles,
  parseSpadeBotSecurity,
  parseSpadeCheckpoints,
  parseSpadeSecurityMachine,
  spadeMachinePlace,
  spadePersonalityBody,
  spadeRoles,
  type SpadeBotSecurity,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { readModelSources } from "./spade-settings.ts";
import { spadeModelChoices, type SpadeModelGroupRow } from "./spade-settings-rows.ts";
import {
  spadeCheckpointRows,
  spadeNetworkRow,
  spadeNextPolicy,
  spadePersonalityRow,
  spadeReachChange,
  spadeReachRow,
  spadeRestoreRefusal,
  spadeRoleRows,
  spadeSpendingRow,
  type SpadeCheckpointRow,
  type SpadeNetworkRow,
  type SpadePersonalityRow,
  type SpadeReachRow,
  type SpadeRoleRow,
} from "./spade-profile-details.ts";
import { segment } from "./spade-text.ts";
import {
  spadeRefused,
  spadeRequestArea,
  type SpadeAsk,
  type SpadeOutcome,
} from "./spade-requests-area.ts";

/*
 * What the person edits on a bot's profile beyond its task: its personality, the models for its
 * other work, its notifications, its network rules and its checkpoints; and its spending, to
 * read. Each section reads and writes on its own (`spade-profile-details.ts` shapes them); a
 * write Spade refuses leaves what it had and says why.
 */

const agentId = z.string().min(1).max(256);
const which = z.enum(["commands", "plugins"]);
const mode = z.enum(["off", "allow_list", "open"]);
const entry = z.string().trim().min(1).max(253);

const noBot = { ok: false, title: "", message: "Spade hasn't listed this bot yet." } as const;

type Part<T> = { ok: true; part: T };

export interface SpadeDetailsRow {
  personality: SpadePersonalityRow;
  spending: { month: string; today: string } | null;
  /** Null when Spade couldn't say: the section isn't shown. */
  reach: SpadeReachRow | null;
}

export interface SpadeRolesRow {
  roles: SpadeRoleRow[];
  groups: SpadeModelGroupRow[];
  more: number;
}

export const spadeProfileDetailRequests = spadeRequestArea(
  [
    /** Personality, spending and notifications: what Details shows under its model. */
    z.object({ type: z.literal("spade.details"), agentId }),
    z.object({
      type: z.literal("spade.personality"),
      agentId,
      tone: z.enum(["concise", "warm", "formal", "playful"]).nullable(),
      humour: z.boolean(),
      emoji: z.boolean(),
    }),
    /** Models for other work, read as its fold opens. */
    z.object({ type: z.literal("spade.roles"), agentId }),
    /** One role to a model, or back to following Settings (`""`). */
    z.object({
      type: z.literal("spade.role"),
      agentId,
      role: z.enum(spadeRoles),
      model: z.string().max(512),
    }),
    z.object({
      type: z.literal("spade.reach"),
      agentId,
      notify: z.boolean().optional(),
      approvals: z.enum(["inherit", "notify", "wait"]).optional(),
    }),
    z.object({ type: z.literal("spade.network"), agentId }),
    z.object({
      type: z.literal("spade.network.set"),
      agentId,
      which,
      change: z.union([
        z.object({ mode }),
        z.object({ add: entry }),
        z.object({ removeEntry: entry }),
        z.object({ removeDefault: entry }),
        z.object({ restoreDefault: entry }),
        /** Back to the machine's rule. */
        z.object({ inherit: z.literal(true) }),
      ]),
    }),
    z.object({ type: z.literal("spade.checkpoints"), agentId }),
    z.object({
      type: z.literal("spade.restore"),
      agentId,
      checkpoint: z.string().min(1).max(256),
    }),
  ],
  async (
    { spade, ask },
    request,
  ): Promise<
    | SpadeOutcome
    | Part<SpadeDetailsRow>
    | Part<SpadePersonalityRow>
    | Part<SpadeRolesRow>
    | Part<SpadeReachRow>
    | Part<SpadeNetworkRow>
    | Part<SpadeCheckpointRow[]>
  > => {
    const bot = spade.bot(request.agentId);
    if (!bot) return noBot;
    const path = `/v1/agents/${segment(request.agentId)}`;
    try {
      switch (request.type) {
        case "spade.details": {
          const reach = await ask("GET", `${path}/reach`).then(
            (body) => spadeReachRow(JSON.parse(body) as { notify: unknown; approvals: unknown }),
            () => null,
          );
          const part = {
            personality: spadePersonalityRow(bot),
            spending: spadeSpendingRow(bot),
            reach,
          };
          return { ok: true, part };
        }
        case "spade.personality": {
          const { tone, humour, emoji } = request;
          const body = await ask("PATCH", path, {
            personality: spadePersonalityBody({ tone: tone ?? undefined, humour, emoji }),
          });
          spade.refresh();
          const stored = parseSpadeAgent(body);
          const part = stored
            ? spadePersonalityRow(stored)
            : { ...spadePersonalityRow(bot), tone, humour, emoji };
          return { ok: true, part };
        }
        case "spade.roles":
          return { ok: true, part: await rolesOf(ask, path, "GET") };
        case "spade.role":
          return {
            ok: true,
            part: await rolesOf(ask, path, "PUT", {
              roles: { [request.role]: request.model || null },
            }),
          };
        case "spade.reach": {
          const change = spadeReachChange(request);
          await ask("PUT", `${path}/reach`, change);
          const read = await ask("GET", `${path}/reach`);
          return {
            ok: true,
            part: spadeReachRow(JSON.parse(read) as { notify: unknown; approvals: unknown }),
          };
        }
        case "spade.network": {
          const [security, machine] = await networkFacts(ask, path);
          return { ok: true, part: spadeNetworkRow(security, machine.defaults, machine.place) };
        }
        case "spade.network.set": {
          const [security, machine] = await networkFacts(ask, path);
          const route = `${path}/security/${request.which === "commands" ? "network" : "plugin-network"}`;
          const change = request.change;
          let body: string;
          if ("inherit" in change) body = await ask("DELETE", route);
          else if ("mode" in change || "add" in change) {
            const policy = request.which === "commands" ? security.network : security.pluginNetwork;
            body = await ask("PUT", route, spadeNextPolicy(policy, change));
          } else {
            const site =
              "removeEntry" in change
                ? { action: "remove_entry", entry: change.removeEntry }
                : "removeDefault" in change
                  ? { action: "remove_default", entry: change.removeDefault }
                  : { action: "restore_default", entry: change.restoreDefault };
            body = await ask("PUT", route, { mode: "site_edit", site });
          }
          const saved = sure(parseSpadeBotSecurity(body), "security settings");
          return { ok: true, part: spadeNetworkRow(saved, machine.defaults, machine.place) };
        }
        case "spade.checkpoints": {
          const list = sure(
            parseSpadeCheckpoints(await ask("GET", `${path}/checkpoints`)),
            "checkpoints",
          );
          return { ok: true, part: spadeCheckpointRows(list) };
        }
        case "spade.restore":
          try {
            await ask("POST", `${path}/checkpoints/${segment(request.checkpoint)}/restore`);
          } catch (error) {
            return { ok: false, title: "", message: spadeRestoreRefusal(bot.name, error) };
          }
          return { ok: true };
      }
    } catch (error) {
      return spadeRefused(failures[request.type], error);
    }
  },
);

const failures = {
  "spade.details": "Couldn't read its details",
  "spade.personality": "Couldn't save its personality",
  "spade.roles": "Couldn't read the models for other work",
  "spade.role": "Couldn't change the model",
  "spade.reach": "Couldn't change its notifications",
  "spade.network": "Couldn't read its network rules",
  "spade.network.set": "Couldn't change its network rule",
  "spade.checkpoints": "Couldn't read its checkpoints",
  "spade.restore": "Couldn't restore the checkpoint",
} as const;

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

async function rolesOf(
  ask: SpadeAsk,
  path: string,
  method: "GET" | "PUT",
  body?: unknown,
): Promise<SpadeRolesRow> {
  const [answer, { sources }] = await Promise.all([
    ask(method, `${path}/models`, body),
    readModelSources(ask),
  ]);
  const roles = sure(parseSpadeBotRoles(answer), "models for other work");
  return { roles: spadeRoleRows(roles, sources), ...spadeModelChoices(sources) };
}

/** The bot's rules, and the machine's listed sites and what it is called. */
async function networkFacts(
  ask: SpadeAsk,
  path: string,
): Promise<[SpadeBotSecurity, { defaults: string[]; place: string }]> {
  const [security, machine] = await Promise.all([
    ask("GET", `${path}/security`).then((body) =>
      sure(parseSpadeBotSecurity(body), "security settings"),
    ),
    ask("GET", "/v1/security").then(
      (body) => parseSpadeSecurityMachine(body),
      () => undefined,
    ),
  ]);
  return [
    security,
    { defaults: machine?.defaults ?? [], place: spadeMachinePlace(machine?.platform) },
  ];
}
