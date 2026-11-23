import type { ClientCore } from "@ace/client";
import type { AceOrgPolicy } from "@ace/protocol/ace-org";
import { SpadeRequestError } from "@ace/ui-core/spade-chat";
import {
  policyDraft,
  policyFromDraft,
  readAuditLines,
  readPolicy,
  type AuditRow,
} from "@ace/ui-core/org";
import { z } from "zod";
import { answerRegistry, registryOperations } from "./organization-registry.ts";
import { spadeText } from "./spade-text.ts";

/*
 * Settings › Organization on the iPhone (ADR 0206 amendment 4): the parts that need web's rules.
 * Swift calls the account backend itself; it asks this machine's runtime for the policy as a
 * form (its lists as lines of text, `@ace/ui-core/org`) and for the body that saves a form as the
 * next version, and, on an org host, for its Spade's signed audit log (`GET
 * /v1/org/audit/export`), newest first, filtered by person and kind, or whole for Export; and
 * the registry's versions and withdrawals (`organization-registry.ts`).
 */

const Rule = z.enum(["unset", "off", "admins", "approvers"]);
const Raise = z.enum(["unset", "never", "admins", "approvers"]);
const effectKeys = [
  "send_as_person",
  "publish",
  "pay",
  "change_access",
  "network_without_hosts",
] as const;
type EffectKey = (typeof effectKeys)[number];

/** The policy as the phone's form holds it: every choice a word or a switch, lists as lines. */
export const PolicyForm = z.object({
  effects: z.object(
    Object.fromEntries(effectKeys.map((key) => [key, Rule])) as Record<EffectKey, typeof Rule>,
  ),
  fullAccess: Raise,
  commandsOutsideSandbox: Raise,
  membersCreateBots: z.boolean(),
  sources: z.object({ market: z.boolean(), registry: z.boolean(), git: z.boolean() }),
  allowlist: z.boolean(),
  allow: z.string().max(65_536),
  block: z.string().max(65_536),
  endpoints: z.string().max(65_536),
  localModels: z.boolean(),
  auditContent: z.enum(["digests", "targets"]),
});
export type PolicyForm = z.infer<typeof PolicyForm>;

const Body = z.string().max(65_536);
const Filter = z.string().min(1).max(256).optional();

export const NativeOrganizationRequest = z.object({
  type: z.literal("native.organization"),
  request: z.discriminatedUnion("op", [
    /** The stored version's body (`GET /v1/orgs/{org}/policy`) as the form. */
    z.object({ op: z.literal("policyForm"), body: Body }),
    /**
     * The `PUT /v1/orgs/{org}/policy` body saving `form` over the stored `body`, which is
     * `version`: the backend refuses it once another version has been saved.
     */
    z.object({
      op: z.literal("policySave"),
      body: Body,
      version: z.number().int().nonnegative(),
      form: PolicyForm,
    }),
    z.object({
      op: z.literal("audit"),
      /** An actor's name as `people` lists it. */
      person: Filter,
      /** An action as `kinds` lists it. */
      kind: Filter,
      /** Pull to refresh: read the log again now. */
      fresh: z.literal(true).optional(),
    }),
    z.object({ op: z.literal("auditExport") }),
    ...registryOperations,
  ]),
});
export type NativeOrganizationRequest = z.infer<typeof NativeOrganizationRequest>;

/** The newest entries the list shows; Export has them all, as on web. */
const shown = 50;
/** A log read is kept this long, so changing a filter doesn't read it again. */
const keptFor = 30_000;

export type OrganizationAudit =
  | {
      ok: true;
      /** The host's audit key, for `ace org audit verify --key`. */
      key: string | null;
      rows: Omit<AuditRow, "action">[];
      people: string[];
      kinds: { action: string; title: string }[];
      checkpoints: number;
      /** Entries in the whole log, before the filter. */
      total: number;
    }
  | { ok: false; message: string };

export interface OrganizationDeps {
  id(): string;
  now(): number;
}

/** One machine's organization requests; its last log read is kept for `keptFor`. */
export class NativeOrganization {
  private last: { at: number; text: string } | undefined;
  private readonly owner: ClientCore;
  private readonly deps: OrganizationDeps;

  constructor(owner: ClientCore, deps: OrganizationDeps) {
    this.owner = owner;
    this.deps = deps;
  }

  async answer(input: NativeOrganizationRequest, signal?: AbortSignal): Promise<unknown> {
    const request = input.request;
    switch (request.op) {
      case "policyForm":
        return { ok: true, form: formOf(readPolicy(request.body)) };
      case "policySave": {
        const policy = policyOf(readPolicy(request.body), request.form);
        return { ok: true, body: JSON.stringify({ policy, version: request.version }) };
      }
      case "audit": {
        const read = await this.readLog(signal, request.fresh === true);
        return "message" in read ? { ok: false, message: read.message } : audit(read.text, request);
      }
      case "registryIntent":
      case "registry":
      case "registryWithdraw":
        return answerRegistry(this.owner, request, signal);
      case "auditExport": {
        const read = await this.readLog(signal, true);
        return "message" in read
          ? { ok: false, message: read.message }
          : { ok: true, text: read.text };
      }
    }
  }

  private async readLog(
    signal: AbortSignal | undefined,
    fresh: boolean,
  ): Promise<{ text: string } | { message: string }> {
    const { deps } = this;
    if (!fresh && this.last && deps.now() - this.last.at < keptFor) return { text: this.last.text };
    try {
      const path = "/v1/org/audit/export";
      const text = await spadeText(this.owner, deps.id, "GET", path, undefined, signal);
      this.last = { at: deps.now(), text };
      return { text };
    } catch (error) {
      if (error instanceof SpadeRequestError && error.status === 404)
        return {
          message: "This machine isn't one of your organization's hosts, so it keeps no audit log.",
        };
      return { message: "Couldn't read this host's log. Try again." };
    }
  }
}

function formOf(policy: AceOrgPolicy): PolicyForm {
  const draft = policyDraft(policy);
  const sources = policy.packages?.sources ?? {};
  return {
    effects: Object.fromEntries(
      effectKeys.map((key) => [key, policy.effects?.[key] ?? "unset"]),
    ) as PolicyForm["effects"],
    fullAccess: policy.full_access ?? "unset",
    commandsOutsideSandbox: policy.commands_outside_sandbox ?? "unset",
    membersCreateBots: policy.members_create_bots !== false,
    sources: {
      market: sources.market ?? true,
      registry: sources.registry ?? true,
      git: sources.git ?? false,
    },
    allowlist: policy.packages?.mode === "allowlist",
    allow: draft.allow,
    block: draft.block,
    endpoints: draft.endpoints,
    localModels: policy.models?.local !== false,
    auditContent: policy.audit?.content ?? "digests",
  };
}

/** A form word as the policy holds it: "unset" leaves the host's own rule. */
const unset = <T extends string>(word: T | "unset") => (word === "unset" ? undefined : word);

/** The form over the stored policy, as web's page saves it: "unset" leaves the host's own rule. */
function policyOf(stored: AceOrgPolicy, form: PolicyForm): AceOrgPolicy {
  const effects = Object.fromEntries(
    effectKeys.flatMap((key) => {
      const rule = unset(form.effects[key]);
      return rule ? [[key, rule]] : [];
    }),
  );
  const policy: AceOrgPolicy = {
    ...stored,
    effects: Object.keys(effects).length ? effects : undefined,
    full_access: unset(form.fullAccess),
    commands_outside_sandbox: unset(form.commandsOutsideSandbox),
    members_create_bots: form.membersCreateBots,
    packages: {
      ...stored.packages,
      sources: form.sources,
      mode: form.allowlist ? "allowlist" : stored.packages?.mode === undefined ? undefined : "open",
    },
    models: { ...stored.models, local: form.localModels },
    audit: { content: form.auditContent },
  };
  return policyFromDraft({
    policy,
    allow: form.allow,
    block: form.block,
    endpoints: form.endpoints,
  });
}

function audit(
  text: string,
  filter: { person?: string | undefined; kind?: string | undefined },
): OrganizationAudit {
  const read = readAuditLines(text);
  const people = [...new Set(read.rows.map((row) => row.actor))].toSorted();
  const kinds = new Map(read.rows.map((row) => [row.action, row.title]));
  const rows = read.rows
    .filter(
      (row) =>
        (!filter.person || row.actor === filter.person) &&
        (!filter.kind || row.action === filter.kind),
    )
    .slice(-shown)
    .toReversed()
    .map(({ action: _action, ...row }) => row);
  return {
    ok: true,
    key: read.header?.key ?? null,
    rows,
    people,
    kinds: [...kinds]
      .map(([action, title]) => ({ action, title }))
      .toSorted((a, b) => a.title.localeCompare(b.title)),
    checkpoints: read.checkpoints,
    total: read.rows.length,
  };
}
