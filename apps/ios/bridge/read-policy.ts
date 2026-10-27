import { z } from "zod";

/*
 * Which daemon reads the phone keeps between visits, and what makes them out of date. The web
 * keeps the same lookups in its query cache (`apps/web/src/lib/query-persistence.ts`): a kept
 * answer is drawn at once and read again behind it, and a daemon change event, a write of the
 * same kind or a reconnect marks it for reading again. Pure: no I/O.
 */

/** A kind of daemon data. Answers of one family go out of date together. */
export type ReadFamily =
  | "projects"
  | "settings"
  | "source-control"
  | "automations"
  | "usage"
  | "plugins"
  | "prompts"
  | "catalog"
  | "forge";

type Raw = Record<string, unknown>;
const Raw = z.record(z.string(), z.unknown());
const record = (value: unknown): Raw | undefined => Raw.safeParse(value).data;
const operation = (request: Raw): string | undefined => {
  const value = record(request.operation)?.op;
  return typeof value === "string" ? value : undefined;
};
const pluginType = (request: Raw): string | undefined => {
  const value = record(request.request)?.type;
  return typeof value === "string" ? value : undefined;
};

const pluginReads = new Set(["plugins.list", "plugins.catalog"]);
/** Plugin requests that only read or let go of a review; every other one changes plugins. */
const pluginLookups = new Set([
  ...pluginReads,
  "plugins.source",
  "plugins.readReview",
  "plugins.review",
  "plugins.prepare",
  "plugins.cancel",
]);
const projectReads = new Set(["workspace.list"]);
const projectLookups = new Set([
  "workspace.list",
  "fs.home",
  "fs.list",
  "workspace.clone.validate",
]);

/** The family a request's answer is kept under, or undefined when it is never kept. */
export function readFamily(request: unknown): ReadFamily | undefined {
  const value = record(request);
  if (!value) return undefined;
  switch (value.type) {
    case "projects.request":
      return projectReads.has(operation(value) ?? "") ? "projects" : undefined;
    case "forge.projects":
      return "projects";
    case "settings.get":
      return "settings";
    case "source-control.request":
      return operation(value) === "readiness" ? "source-control" : undefined;
    case "automation.list":
    case "automation.inbox":
      return "automations";
    case "usage.limits":
    case "usage.summary":
      return "usage";
    case "pluginRequest":
      return pluginReads.has(pluginType(value) ?? "") ? "plugins" : undefined;
    case "prompts.request":
      return operation(value) === "list" ? "prompts" : undefined;
    case "catalog.list":
      return "catalog";
    case "forge.pulls":
    case "forge.issues":
    case "forge.pull":
    case "forge.issue":
    case "forge.pull.timeline":
    case "forge.pull.file":
    case "forge.pull.files":
    case "forge.pull.reviewers":
    case "forge.inbox":
    case "forge.pull.manage":
    case "forge.newpr.context":
    case "forge.newpr.compare":
    case "forge.pull.checks":
    case "forge.pull.check":
    case "forge.pull.conflicts":
    case "forge.pull.stack":
    case "forge.pull.work":
      return "forge";
    default:
      return undefined;
  }
}

/** The families a request that changes daemon data puts out of date (the web's invalidations). */
export function writeFamilies(request: unknown): readonly ReadFamily[] {
  const value = record(request);
  if (!value || readFamily(value)) return [];
  switch (value.type) {
    case "projects.request":
      return projectLookups.has(operation(value) ?? "") ? [] : ["projects", "source-control"];
    case "settings.set":
    case "settings.reset":
      return ["settings", "source-control"];
    case "automation.put":
    case "automation.remove":
    case "automation.run":
    case "automation.manage":
      return ["automations"];
    case "pluginRequest":
      return pluginLookups.has(pluginType(value) ?? "") ? [] : ["plugins", "catalog"];
    case "prompts.request":
      return ["prompts"];
    case "forge.merge":
    case "forge.auto-merge":
    case "forge.review":
    case "forge.inbox.write":
    case "forge.task":
    case "forge.manage":
    case "forge.newpr.create":
    case "forge.issue.comment":
    case "forge.issue.check":
    case "forge.checks.write":
    case "forge.local.write":
    case "forge.conflicts":
    case "forge.stack":
    case "forge.worktree":
      return ["forge"];
    default:
      return [];
  }
}

/** The families a daemon broadcast puts out of date. */
export function eventFamilies(type: string): readonly ReadFamily[] {
  switch (type) {
    case "workspace.changed":
      return ["projects", "source-control"];
    case "settings.changed":
      return ["settings", "source-control"];
    case "usage.updated":
    case "accounts.changed":
      return ["usage"];
    case "plugins.removed":
      return ["plugins", "catalog"];
    case "catalog.changed":
    case "models.changed":
    case "providers.changed":
      return ["catalog"];
    case "forge.pr.updated":
      return ["forge"];
    default:
      return [];
  }
}

/**
 * Whether an answer is worth keeping: a refusal (`ok: false`, an error result) is shown once
 * and asked again next time, never drawn from the cache.
 */
export function keepable(value: unknown): boolean {
  const reply = record(value);
  if (!reply) return value !== undefined;
  if (reply.ok === false) return false;
  const result = record(reply.result);
  if (result && (result.kind === "error" || result.ok === false)) return false;
  const response = record(reply.response);
  return !(typeof response?.type === "string" && response.type.endsWith("error"));
}
