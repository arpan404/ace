import type { ClientCore } from "@ace/client";
import { SettingsKey, SettingsProvenance, SettingsValues } from "@ace/protocol";
import { roleKeys, runRoles } from "@ace/settings/roles";
import { catalogModelIds } from "@ace/ui-core";
import { z } from "zod";
import { readAgents, type AgentRead } from "./agent-read.ts";
import type { Preview } from "./agents.ts";
import { ModelFavorites } from "./model-favorites.ts";
import { pickerRows } from "./new-thread-agents.ts";
import {
  defaultProviderRow,
  defaultProviderWrite,
  modelPick,
  roleLinkRow,
  roleRows,
  roleWrite,
  utilityAgents,
  utilityRow,
  utilityWrite,
  type AgentsContext,
  type Role,
  type Writes,
} from "./settings-page-agents.ts";
import {
  choiceId,
  settingsPages,
  type PageSpec,
  type RowSpec,
  type StaticRow,
} from "./settings-page-rows.ts";
import {
  lockedByEnvironment,
  lockedReason,
  pageSource,
  type PageRow,
  type ReadEntry,
  type ReadValues,
  type SettingsPage,
  type SettingsPageWrite,
} from "./settings-page-wire.ts";

/*
 * Native settings pages (`settings.page`): one machine's settings for a page, read in parallel
 * and shaped into rows the phone draws as they are (`settings-page-wire.ts`). A change
 * (`settings.page.set`) is checked against this machine's own rows (its choices, its providers
 * and models, an environment override) before it is written, then the page is read again, so
 * the phone shows what the machine kept. The model sheet for a role or the utility model
 * (`settings.models`) lists the composer picker's tabs and rows (`pickerRows`).
 */

const PageId = z.string().min(1).max(64);
export const SettingsPageRequest = z.object({ type: z.literal("settings.page"), page: PageId });
export const SettingsPageSet = z.object({
  type: z.literal("settings.page.set"),
  page: PageId,
  row: z.string().min(1).max(128),
  value: z.unknown(),
});
export const SettingsModelsRequest = z.object({
  type: z.literal("settings.models"),
  page: PageId,
  row: z.string().min(1).max(128),
});
export const SettingsModelStar = z.object({
  type: z.literal("settings.models.star"),
  key: z.string().min(1).max(512),
});

type Owner = Pick<ClientCore, "request">;
export interface PagePorts {
  owner: Owner;
  now(): number;
  preview: Preview;
  signal?: AbortSignal;
}
const quiet = (signal?: AbortSignal) => ({ timeoutMs: 15_000, ...(signal ? { signal } : {}) });
const Entries = z.object({
  ok: z.boolean().optional(),
  entries: z.array(
    z.object({ key: z.string(), value: z.unknown(), provenance: SettingsProvenance }),
  ),
  diagnostics: z.array(z.object({ message: z.string() })).optional(),
});

class PageMissing extends Error {}

function spec(page: string): PageSpec {
  const role = roleOf(page);
  if (role)
    return {
      id: page,
      title: `${role.charAt(0).toUpperCase()}${role.slice(1)}`,
      sections: [{ id: "role", title: null, footer: null, rows: [{ kind: "role", role }] }],
    };
  const found = settingsPages[page];
  if (!found) throw new PageMissing();
  return found;
}
function roleOf(page: string): Role | undefined {
  const name = page.startsWith("role.") ? page.slice(5) : "";
  return runRoles.find((role) => role === name);
}
const isRolePage = (page: string) => roleOf(page) !== undefined;

function keysOf(page: PageSpec): SettingsKey[] {
  const keys = new Set<SettingsKey>();
  for (const section of page.sections)
    for (const row of section.rows) {
      if (row.kind === "static") keys.add(row.key);
      if (row.kind === "defaultProvider") keys.add("providers.default");
      if (row.kind === "utilityModel") keys.add("generation.model");
      if (row.kind === "role") for (const key of Object.values(roleKeys(row.role))) keys.add(key);
    }
  return [...keys];
}
const needsAgents = (page: PageSpec) =>
  page.sections.some((section) => section.rows.some((row) => row.kind !== "static"));

async function readValues(ports: PagePorts, keys: readonly SettingsKey[]): Promise<ReadValues> {
  const replies = await Promise.all(
    keys.map((key) =>
      ports.owner.request({ type: "settings.get", key, scope: {} }, quiet(ports.signal)),
    ),
  );
  const values = new Map<SettingsKey, ReadEntry>();
  for (const reply of replies)
    for (const entry of Entries.parse(reply).entries) {
      const key = SettingsKey.safeParse(entry.key);
      if (key.success) values.set(key.data, { value: entry.value, provenance: entry.provenance });
    }
  return values;
}

interface Read {
  spec: PageSpec;
  values: ReadValues;
  agents: AgentRead | undefined;
}
async function read(ports: PagePorts, page: string): Promise<Read> {
  const found = spec(page);
  const [values, agents] = await Promise.all([
    readValues(ports, keysOf(found)),
    needsAgents(found)
      ? readAgents(ports.owner, new ModelFavorites(ports.owner), ports.now())
      : Promise.resolve(undefined),
  ]);
  return { spec: found, values, agents };
}

function shape(state: Read, preview: Preview): SettingsPage {
  const context: AgentsContext | undefined = state.agents && {
    agents: state.agents.agents,
    catalog: state.agents.catalog,
    values: state.values,
  };
  const rolePage = isRolePage(state.spec.id);
  return {
    type: "settings.page",
    page: state.spec.id,
    title: state.spec.title,
    sections: state.spec.sections.map((section) => ({
      id: section.id,
      title: section.title,
      footer: section.footer,
      rows: section.rows
        .flatMap((row) => build(row, state.values, context, rolePage))
        .map((row) => bounded(row, preview)),
    })),
  };
}
function build(
  row: RowSpec,
  values: ReadValues,
  context: AgentsContext | undefined,
  rolePage: boolean,
): PageRow[] {
  if (row.kind === "static") return [staticRow(row, values)];
  if (!context) return [];
  if (row.kind === "defaultProvider") return [defaultProviderRow(context)];
  if (row.kind === "utilityModel") return [utilityRow(context)];
  return rolePage ? roleRows(context, row.role) : [roleLinkRow(context, row.role)];
}
function staticRow(row: StaticRow, values: ReadValues): PageRow {
  const entry = values.get(row.key);
  const current = entry?.value;
  const control =
    row.control.kind === "choice"
      ? {
          kind: "choice" as const,
          style: row.control.style,
          choices: row.control.choices(current).map(({ id, label }) => ({ id, label })),
        }
      : row.control;
  return {
    id: row.key,
    key: row.key,
    title: row.title,
    control,
    value: row.control.kind === "choice" ? choiceId(current) : (current ?? null),
    note: row.note?.(current) ?? null,
    source: pageSource(entry),
    locked: lockedReason(entry),
    empty: null,
  };
}
function bounded(row: PageRow, preview: Preview): PageRow {
  const control =
    row.control.kind === "model" || row.control.kind === "link"
      ? { ...row.control, label: preview(row.control.label, 128) }
      : row.control;
  return { ...row, title: preview(row.title, 128), control };
}

/** The page as this machine has it now. */
export async function readSettingsPage(
  ports: PagePorts,
  page: string,
): Promise<SettingsPage | { ok: false; message: string }> {
  try {
    return shape(await read(ports, page), ports.preview);
  } catch (error) {
    if (error instanceof PageMissing)
      return { ok: false, message: "This page isn't on this machine's version of ace." };
    throw error;
  }
}

/** One change on a page: checked here, written in order, then the page read again. */
export async function writeSettingsPage(
  ports: PagePorts,
  request: z.infer<typeof SettingsPageSet>,
): Promise<SettingsPageWrite> {
  let state: Read;
  try {
    state = await read(ports, request.page);
  } catch (error) {
    if (error instanceof PageMissing)
      return {
        ok: false,
        message: "This page isn't on this machine's version of ace.",
        page: null,
      };
    throw error;
  }
  const planned = plan(state, request.row, request.value);
  if (!planned.ok)
    return { ok: false, message: planned.message, page: shape(state, ports.preview) };
  for (const [key, value] of planned.writes) {
    const reply = Entries.parse(
      await ports.owner.request(
        { type: "settings.set", key, value: z.json().parse(value), layer: { kind: "global" } },
        quiet(ports.signal),
      ),
    );
    if (reply.ok === false) {
      const message = reply.diagnostics?.[0]?.message ?? "This machine didn't save that change.";
      return { ok: false, message, page: shape(await read(ports, request.page), ports.preview) };
    }
  }
  return { ok: true, page: shape(await read(ports, request.page), ports.preview) };
}

function plan(state: Read, rowId: string, value: unknown): Writes {
  const context: AgentsContext | undefined = state.agents && {
    agents: state.agents.agents,
    catalog: state.agents.catalog,
    values: state.values,
  };
  const role = roleOf(state.spec.id);
  const rows = state.spec.sections.flatMap((section) => section.rows);
  const statics = rows.filter((row): row is StaticRow => row.kind === "static");
  const found = statics.find((row) => row.key === rowId);
  const locked = (key: SettingsKey) => state.values.get(key)?.provenance === "environment";
  const refuseLocked = (writes: Writes): Writes =>
    writes.ok && writes.writes.some(([key]) => locked(key))
      ? { ok: false, message: lockedByEnvironment }
      : writes;
  if (found) return refuseLocked(staticWrite(found, state.values, value));
  if (!context) return { ok: false, message: "This setting isn't on this page." };
  if (rowId === "providers.default" && rows.some((row) => row.kind === "defaultProvider"))
    return refuseLocked(defaultProviderWrite(context, value));
  if (rowId === "generation.model" && rows.some((row) => row.kind === "utilityModel"))
    return refuseLocked(utilityWrite(context, value));
  if (role) return refuseLocked(roleWrite(context, role, rowId, value));
  return { ok: false, message: "This setting isn't on this page." };
}

function staticWrite(row: StaticRow, values: ReadValues, raw: unknown): Writes {
  const value = staticValue(row, values, raw);
  if (value === undefined) return { ok: false, message: `That isn't a choice for ${row.title}.` };
  const parsed = SettingsValues.shape[row.key].safeParse(value);
  if (!parsed.success) {
    const custom = parsed.error.issues.find((issue) => issue.code === "custom")?.message;
    return { ok: false, message: custom ?? `That value isn't allowed for ${row.title}.` };
  }
  return { ok: true, writes: [[row.key, parsed.data]] };
}
function staticValue(row: StaticRow, values: ReadValues, raw: unknown): unknown {
  switch (row.control.kind) {
    case "toggle":
      return typeof raw === "boolean" ? raw : undefined;
    case "choice":
      return row.control.choices(values.get(row.key)?.value).find((choice) => choice.id === raw)
        ?.value;
    case "text":
      return typeof raw === "string" ? raw.trim() : undefined;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "list":
      return Array.isArray(raw)
        ? raw
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : undefined;
  }
}

/** The model sheet for a role or the utility model: the composer picker's tabs and rows. */
export async function readSettingsModels(
  ports: PagePorts,
  request: z.infer<typeof SettingsModelsRequest>,
) {
  const favorites = new ModelFavorites(ports.owner);
  const [agents, values] = await Promise.all([
    readAgents(ports.owner, favorites, ports.now()),
    readValues(
      ports,
      request.row === "generation.model" ? ["generation.model"] : keysForRole(request.page),
    ),
  ]);
  const utility = request.row === "generation.model";
  const listed = utility ? utilityAgents(agents.agents) : agents.agents;
  const context = { agents: agents.agents, catalog: agents.catalog, values };
  const role = roleOf(request.page);
  const row = utility ? utilityRow(context) : role ? roleRows(context, role)[0] : undefined;
  const pick = modelPick(row?.value);
  const provider = row?.control.kind === "model" ? row.control.provider : null;
  const current = pick && provider ? { provider, key: pick.key, account: pick.account } : undefined;
  return {
    type: "settings.models",
    state: "ready",
    ...pickerRows(listed, current, current?.provider, ports.preview, {
      keys: agents.stars,
      problem: null,
    }),
    current: current ?? null,
  };
}
function keysForRole(page: string): SettingsKey[] {
  const role = roleOf(page);
  return role ? Object.values(roleKeys(role)) : [];
}

/** Stars or unstars a model in the settings model sheet, where the composer keeps stars. */
export async function starSettingsModel(ports: PagePorts, key: string) {
  const favorites = new ModelFavorites(ports.owner);
  const agents = await readAgents(ports.owner, favorites, ports.now());
  const keys = await favorites.toggle(key, catalogModelIds(agents.catalog.models));
  return { type: "settings.models.star", favorites: keys };
}
