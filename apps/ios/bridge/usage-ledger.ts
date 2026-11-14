import type { ClientCore } from "@ace/client";
import { ProviderKind, UsageQuery, UsageRow, type UsageDimension } from "@ace/protocol";
import {
  accountView,
  canonicalLedgerRead,
  catalogModelIds,
  catalogModelNames,
  dayRange,
  formatTokens,
  formatUsd,
  ledgerChange,
  ledgerGroups,
  ledgerLines,
  ledgerTop,
  machineLedgerLines,
  nextLedgerGroup,
  providerNames,
  readLedgerGroup,
  readModelCatalog,
  roleLabels,
  unpricedLine,
  usageCoverage,
  type LedgerFigure,
  type LedgerGroup,
  type LedgerLine,
  type LedgerRead,
  type ModelCatalog,
} from "@ace/ui-core";
import { z } from "zod";
import { host } from "./host.ts";
import { preview } from "./presentation.ts";
import { readProjects } from "./project-list.ts";
import { UsageMachineReach, type UsageCoverageView } from "./usage-report.ts";

/*
 * The Usage screen's ledger, as web's: spend grouped by one dimension (provider, account,
 * project, model, machine, automation, skill, agent), each row with its share, its days as a
 * trend and its change against the span before. A row opens to the level below within its
 * scope. Each machine reads its own part and names its own keys (`usage.ledgerPart`); the parts
 * are summed by the web's ledger in shared code (`usage.combineLedger`), never in Swift.
 */

const quiet = { timeoutMs: 15_000 };
const Day = z.iso.date();
const Group = z.enum([
  "provider",
  "account",
  "workspace",
  "model",
  "machine",
  "automation",
  "skill",
  "role",
]);
const Values = z.array(z.string().min(1).max(256)).max(50);
/** A row's scope, as the steps opened above it (`ledgerScope`); a machine step is the machine. */
const Filters = z
  .object({
    provider: Values,
    account: Values,
    workspace: Values,
    model: Values,
    automation: Values,
    skill: Values,
    role: Values,
  })
  .partial();

export const UsageLedgerPartRequest = z.object({
  type: z.literal("usage.ledgerPart"),
  group: Group,
  from: Day,
  to: Day,
  filters: Filters,
});
export type UsageLedgerPartRequest = z.infer<typeof UsageLedgerPartRequest>;

const Rows = z.array(UsageRow).max(2000);
const Name = z.object({
  key: z.string().max(256),
  name: z.string().max(256),
  /** The provider whose mark the row wears; null when it has none. */
  provider: z.string().max(64).nullable(),
});
export const UsageLedgerPart = z.object({
  type: z.literal("usage.ledgerPart"),
  from: Day,
  to: Day,
  totals: Rows,
  previous: Rows,
  series: Rows,
  /** This machine's names for the keys it read. */
  names: z.array(Name).max(2000),
});
export type UsageLedgerPart = z.infer<typeof UsageLedgerPart>;

const providerName = (id: string) => {
  const kind = ProviderKind.safeParse(id);
  return kind.success ? providerNames[kind.data] : id;
};

/** The keys a read holds for its group, each once. */
const keysOf = (read: LedgerRead, group: Exclude<LedgerGroup, "machine">) => [
  ...new Set(read.totals.flatMap((row) => row.dimensions[group] ?? [])),
];

async function namesOf(
  owner: ClientCore,
  group: LedgerGroup,
  read: LedgerRead,
  catalog: ModelCatalog,
  signal: AbortSignal,
): Promise<z.infer<typeof Name>[]> {
  // A machine is named by the phone, which knows what the person calls it.
  if (group === "machine") return [];
  const keys = keysOf(read, group);
  const named = (name: (key: string) => string, provider: (key: string) => string | null) =>
    keys.map((key) => ({ key, name: preview(name(key), 256), provider: provider(key) }));
  switch (group) {
    case "provider":
      return named(providerName, (key) => key);
    case "account": {
      const reply = await owner
        .request({ type: "accounts.list", requestId: host.uuid() }, { signal, ...quiet })
        .catch(() => undefined);
      const accounts = new Map((reply?.accounts ?? []).map((each) => [each.id, accountView(each)]));
      return named(
        (key) => {
          const account = accounts.get(key);
          return account ? `${account.providerLabel} · ${account.label}` : "Account";
        },
        (key) => accounts.get(key)?.provider ?? null,
      );
    }
    case "workspace": {
      const projects = await readProjects(owner, { signal, ...quiet }, 500).catch(() => []);
      const names = new Map(projects.map((project) => [project.id as string, project.name]));
      return named(
        (key) => names.get(key) ?? "Project",
        () => null,
      );
    }
    case "model": {
      const label = catalogModelNames(catalog.models);
      const provider = new Map(
        read.totals.flatMap((row) =>
          row.dimensions.model ? [[row.dimensions.model, row.dimensions.provider ?? ""]] : [],
        ),
      );
      return named(
        (key) => label(provider.get(key) ?? "", key),
        (key) => provider.get(key) || null,
      );
    }
    case "automation": {
      const reply = await owner
        .request({ type: "automation.list", includeThreads: true }, { signal, ...quiet })
        .catch(() => undefined);
      const titles = new Map(
        [
          ...(reply?.automations ?? []),
          ...(reply?.threadAutomations ?? []).map((each) => each.automation),
        ].map((each) => [each.id, each.title]),
      );
      return named(
        (key) => titles.get(key) ?? "Automation",
        () => null,
      );
    }
    case "role":
      return named(
        (key) => roleLabels[key] ?? key,
        () => null,
      );
    default:
      return named(
        (key) => key,
        () => null,
      );
  }
}

/** One machine's part of the ledger for a grouping within a scope, its keys named here. */
export async function readLedgerPart(
  owner: ClientCore,
  request: UsageLedgerPartRequest,
  signal: AbortSignal,
): Promise<UsageLedgerPart> {
  const span = { from: request.from, to: request.to };
  const catalog =
    request.group === "model"
      ? await readModelCatalog(owner, {}, signal).catch((): ModelCatalog => ({
          models: [],
          instances: [],
        }))
      : { models: [], instances: [] };
  const canonical = catalogModelIds(catalog.models);
  const read = await readLedgerGroup(
    async (kind, at, groupBy: UsageDimension[], filters, limit) => {
      const query = UsageQuery.parse({
        ...at,
        groupBy,
        filters,
        equivalentApiCost: true,
        orderBy: "cost",
        limit,
      });
      const type = kind === "series" ? "usage.series" : "usage.summary";
      const reply = await owner.request(
        { type, query, requestId: host.uuid() },
        { signal, ...quiet },
      );
      return reply.result.rows;
    },
    span,
    Object.fromEntries(
      Object.entries(request.filters).filter((entry): entry is [string, string[]] => !!entry[1]),
    ),
    request.group,
  );
  const named =
    request.group === "model"
      ? canonicalLedgerRead(read, (provider, model) => canonical(provider, model) ?? model)
      : read;
  return {
    type: "usage.ledgerPart",
    ...span,
    totals: [...named.totals],
    previous: [...named.previous],
    series: [...named.series],
    names: await namesOf(owner, request.group, named, catalog, signal),
  };
}

const Machine = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  reach: UsageMachineReach,
});

export const UsageLedgerCombineRequest = z.object({
  type: z.literal("usage.combineLedger"),
  group: Group,
  from: Day,
  to: Day,
  /** The row this level opened from, so an account under its provider drops the provider's name. */
  parent: z.object({ group: Group, label: z.string().max(256) }).optional(),
  machines: z
    .array(Machine.extend({ part: UsageLedgerPart.optional() }))
    .min(1)
    .max(32),
});
export type UsageLedgerCombineRequest = z.infer<typeof UsageLedgerCombineRequest>;

/** One metric of a row: its figure and its change against the span before ("+12%"). */
interface LedgerCell {
  figure: string;
  change: string;
}

export interface UsageLedgerRow {
  key: string;
  name: string;
  provider: string | null;
  cost: LedgerCell;
  tokens: LedgerCell;
  /** Its share of this level, 0 to 1, per metric. */
  share: { cost: number; tokens: number };
  /** One value per day of the span, per metric; empty when its days weren't read. */
  trend: { cost: number[]; tokens: number[] };
}

export interface UsageLedgerReply {
  type: "usage.ledger";
  group: LedgerGroup;
  /** What a row opens to, shaped as `groups`' entries; null when a row is as deep as it goes. */
  next: { value: LedgerGroup; label: string } | null;
  /** Every grouping, for the Group by menu. */
  groups: { value: LedgerGroup; label: string }[];
  /** Most cost first; the phone shows the first `top` and "Show all". */
  rows: UsageLedgerRow[];
  top: number;
  coverage: UsageCoverageView;
}

const groupLabel = (group: LedgerGroup) =>
  ledgerGroups.find((entry) => entry.value === group)?.label ?? group;

function fallbackName(group: LedgerGroup, key: string): string {
  if (group === "provider") return providerName(key);
  if (group === "role") return roleLabels[key] ?? key;
  if (group === "account") return "Account";
  if (group === "workspace") return "Project";
  if (group === "automation") return "Automation";
  return key;
}

/** Every counted machine's part summed by the web's ledger, worded for the phone. Pure. */
export function combineLedger(request: UsageLedgerCombineRequest): UsageLedgerReply {
  const span = { from: request.from, to: request.to };
  const reaches = request.machines.map((machine) => {
    if (machine.reach !== "counted") return { machine, reach: machine.reach, part: undefined };
    const part = machine.part;
    if (!part) return { machine, reach: "failed" as const, part: undefined };
    // A part read over other days (an older visit) is still being read again.
    if (part.from !== span.from || part.to !== span.to)
      return { machine, reach: "loading" as const, part: undefined };
    return { machine, reach: "counted" as const, part };
  });
  const coverage = usageCoverage(
    reaches.map(({ machine, reach }) => ({ id: machine.id, name: machine.name, reach })),
  );
  const answered = reaches.flatMap((entry) =>
    entry.part ? [{ key: entry.machine.id, name: entry.machine.name, read: entry.part }] : [],
  );
  const days = dayRange(span.from, span.to);
  const group = request.group;
  const lines =
    group === "machine"
      ? machineLedgerLines(answered, days)
      : ledgerLines(
          answered.map((entry) => entry.read),
          group,
          days,
        );
  const names = new Map<string, { name: string; provider: string | null }>();
  for (const entry of answered) {
    if (group === "machine") names.set(entry.key, { name: entry.name, provider: null });
    else for (const each of entry.read.names) if (!names.has(each.key)) names.set(each.key, each);
  }
  const prefix = request.parent?.group === "provider" ? `${request.parent.label} · ` : "";
  const nameOf = (key: string) => {
    const full = names.get(key)?.name ?? fallbackName(group, key);
    return prefix && full.startsWith(prefix) ? full.slice(prefix.length) : full;
  };
  const whole = (value: (line: LedgerLine) => number) =>
    Math.max(
      1e-9,
      lines.reduce((sum, line) => sum + value(line), 0),
    );
  const totalCost = whole((line) => line.usd);
  const totalTokens = whole((line) => line.tokens);
  const next = nextLedgerGroup(group);
  return {
    type: "usage.ledger",
    group,
    next: next ? { value: next, label: groupLabel(next) } : null,
    groups: ledgerGroups.map((each) => ({ value: each.value, label: each.label })),
    rows: lines.map((line) => ({
      key: line.key,
      name: nameOf(line.key),
      provider: group === "provider" ? line.key : (names.get(line.key)?.provider ?? null),
      cost: {
        figure: unpricedLine(line) ? "Unpriced" : formatUsd(line.usd),
        change: ledgerChange(line, "cost").label,
      },
      tokens: { figure: formatTokens(line.tokens), change: ledgerChange(line, "tokens").label },
      share: { cost: line.usd / totalCost, tokens: line.tokens / totalTokens },
      trend: {
        cost: line.days.map((day: LedgerFigure) => day.usd),
        tokens: line.days.map((day: LedgerFigure) => day.tokens),
      },
    })),
    top: ledgerTop,
    coverage: { line: coverage.line, complete: coverage.complete },
  };
}
