import { z } from "zod";
import type { ServicePlan } from "./plan.ts";
import type { TaskPlan } from "./plan.ts";

const variables = new Set([
  "ACE_HOME",
  "PATH",
  "ACE_AUTO_UPDATE",
  "ACE_PORT",
  "ACE_REMOTE_PORT",
  "ACE_LISTEN",
  "ACE_LOG_LEVEL",
  "ACE_ADVERTISE_HOST",
  "ACE_WEB_ORIGINS",
]);
const entries = z.array(z.tuple([z.string(), z.string()])).max(10);
function environment(plan: ServicePlan, content: string): { program: string; home: string } {
  const found =
    plan.platform === "darwin"
      ? /<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s.exec(content)
      : /^Environment=(.*)$/m.exec(content);
  if (!found?.[0] || found[1] === undefined) throw new Error("Missing environment");
  const body = found[1];
  const pattern =
    plan.platform === "darwin"
      ? /<key>([^<]+)<\/key><string>([^<]*)<\/string>/g
      : /"((?:[^"\\]|\\.)*)"/g;
  const decoded: [string, string][] = [];
  let consumed = "";
  for (const match of body.matchAll(pattern)) {
    consumed += (plan.platform === "linux" && consumed ? " " : "") + match[0];
    if (plan.platform === "darwin") decoded.push([match[1] ?? "", match[2] ?? ""]);
    else {
      const token = match[1] ?? "",
        at = token.indexOf("=");
      decoded.push([token.slice(0, at), token.slice(at + 1)]);
    }
  }
  if (consumed !== body) throw new Error("Unrecognized environment syntax");
  const parsed = entries.parse(decoded),
    seen = new Set<string>();
  for (const [key] of parsed) {
    if (!variables.has(key) || seen.has(key))
      throw new Error("Unrecognized or duplicate environment variable");
    seen.add(key);
  }
  const home = parsed.find(([key]) => key === "ACE_HOME")?.[1];
  if (!home) throw new Error("Missing installation home");
  return { program: content.replace(found[0], "ENVIRONMENT"), home };
}
export function incompatibleService(plan: ServicePlan, cause?: unknown): Error {
  return new Error(
    `Incompatible or legacy ace service at ${plan.file}. Refusing to adopt, start or modify it. Choose a separate ACE_HOME; leave migration to the owner.`,
    { cause },
  );
}
/** Only the complete generated program is accepted. Reinstall may change supported environment values. */
export function assertRegistration(plan: ServicePlan, content: string): void {
  try {
    const actual = environment(plan, content),
      expected = environment(plan, plan.content);
    if (actual.program !== expected.program || actual.home !== expected.home)
      throw new Error("Unrecognized service program or home");
  } catch (cause) {
    throw incompatibleService(plan, cause);
  }
}

const properties = [
  "LoadState",
  "ActiveState",
  "FragmentPath",
  "ExecStart",
  "ExecCondition",
  "ExecStartPre",
  "ExecStartPost",
  "ExecReload",
  "ExecStop",
  "ExecStopPost",
  "DropInPaths",
] as const;
export const loadedProperties = properties.join(",");
/** Validate the manager's loaded program independently of the registration file. */
export function assertLoadedService(plan: ServicePlan, output: string): boolean {
  try {
    if (output.length > 64 * 1024) throw new Error("Loaded service output limit exceeded");
    if (plan.platform === "darwin") {
      if (
        (output.match(/^\tpath = /gm)?.length ?? 0) !== 1 ||
        (output.match(/^\tprogram = /gm)?.length ?? 0) !== 1 ||
        (output.match(/^\targuments = \{/gm)?.length ?? 0) !== 1
      )
        throw new Error("Ambiguous loaded launchd identity");
      const path = /^\tpath = (.+)$/m.exec(output)?.[1];
      const program = /^\tprogram = (.+)$/m.exec(output)?.[1];
      const argumentsBlock = /^\targuments = \{\n(.*?)^\t\}/ms.exec(output)?.[1];
      const args = argumentsBlock
        ?.split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (
        path !== plan.file ||
        program !== plan.command[0] ||
        !args ||
        args.length !== 2 ||
        args[0] !== plan.command[0] ||
        args[1] !== "supervise"
      )
        throw new Error("Loaded launchd program mismatch");
      return true;
    } else {
      const rows = new Map<string, string>();
      for (const line of output.trimEnd().split("\n")) {
        const at = line.indexOf("=");
        if (at < 1 || rows.has(line.slice(0, at)))
          throw new Error("Invalid loaded service properties");
        rows.set(line.slice(0, at), line.slice(at + 1));
      }
      // systemd 259+ leaves empty Exec* properties out of `systemctl show`: absent is empty.
      const known = new Set<string>(properties);
      if ([...rows.keys()].some((key) => !known.has(key)))
        throw new Error("Unrecognized loaded service properties");
      if (!rows.has("LoadState") || !rows.has("ActiveState"))
        throw new Error("Missing loaded service properties");
      for (const key of properties) if (!rows.has(key)) rows.set(key, "");
      if (rows.get("LoadState") === "not-found") {
        if (properties.slice(2).some((key) => rows.get(key) !== ""))
          throw new Error("Unrecognized missing unit");
        return false;
      }
      if (rows.get("LoadState") !== "loaded") throw new Error("Unrecognized unit load state");
      if (
        rows.get("FragmentPath") !== plan.file ||
        properties.slice(4).some((key) => rows.get(key) !== "")
      )
        throw new Error("Loaded unit hooks, drop-ins or identity mismatch");
      const start = rows.get("ExecStart") ?? "";
      if ((start.match(/\{/g)?.length ?? 0) !== 1 || (start.match(/\}/g)?.length ?? 0) !== 1)
        throw new Error("Multiple loaded commands");
      const path = /(?:^\{\s*|;\s*)path=(.*?)\s*;/.exec(start)?.[1];
      const args = /;\s*argv\[\]=(.*?)\s*;/.exec(start)?.[1];
      if (path !== plan.command[0] || args !== plan.command.join(" "))
        throw new Error("Loaded systemd program mismatch");
      const state = z
        .enum(["active", "activating", "reloading", "inactive", "failed", "deactivating"])
        .parse(rows.get("ActiveState"));
      return state !== "inactive" && state !== "failed";
    }
  } catch (cause) {
    throw incompatibleService(plan, cause);
  }
}

export function incompatibleTask(plan: TaskPlan, cause?: unknown): Error {
  return new Error(
    `Incompatible or legacy ace service task ${plan.name}. Refusing to adopt, start or modify it. Choose a separate ACE_HOME; leave migration to the owner.`,
    { cause },
  );
}

/** ace's own record of the task must be exactly what this build generates for the home. */
export function assertTaskRegistration(plan: TaskPlan, content: string): void {
  if (content !== plan.content)
    throw incompatibleTask(plan, new Error("Unrecognized task registration"));
}

const decode = (value: string) =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

function only(xml: string, tag: string): string {
  const found = [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>(.*?)</${tag}>`, "gs"))];
  if (found.length !== 1 || found[0]?.[1] === undefined)
    throw new Error(`Expected exactly one ${tag}`);
  return found[0][1];
}

/**
 * Validates the task Task Scheduler holds (`schtasks /Query /XML`), independently of ace's
 * record: one logon trigger and one program, both ace's, for this user.
 */
export function assertLoadedTask(plan: TaskPlan, output: string): void {
  try {
    if (output.length > 64 * 1024) throw new Error("Loaded task output limit exceeded");
    const actions = only(output, "Actions");
    if (/<(?:ComHandler|SendEmail|ShowMessage)\b/.test(actions))
      throw new Error("Unrecognized task action");
    const exec = only(actions, "Exec");
    if (/<WorkingDirectory\b/.test(exec)) throw new Error("Unrecognized task working directory");
    if (
      decode(only(exec, "Command").trim()).toLowerCase() !== plan.program.toLowerCase() ||
      decode(only(exec, "Arguments").trim()) !== plan.arguments
    )
      throw new Error("Loaded task program mismatch");
    const triggers = only(output, "Triggers");
    if ([...triggers.matchAll(/<(\w+Trigger)\b/g)].map((m) => m[1]).join() !== "LogonTrigger")
      throw new Error("Unrecognized task triggers");
    const principal = only(only(output, "Principals"), "Principal");
    if (
      decode(only(principal, "UserId").trim()).toLowerCase() !== plan.user.toLowerCase() ||
      only(principal, "LogonType").trim() !== "InteractiveToken"
    )
      throw new Error("Loaded task principal mismatch");
  } catch (cause) {
    throw incompatibleTask(plan, cause);
  }
}

/** Task Scheduler's "task is currently running" result (`SCHED_S_TASK_RUNNING`), not localized. */
const taskRunning = "267009";

/** Whether `schtasks /Query /V /FO CSV /NH` output shows the task's program running. */
export function taskActive(plan: TaskPlan, output: string): boolean {
  const rows = output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) =>
      [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => (m[1] ?? "").replaceAll('""', '"')),
    );
  const row = rows.find((cells) => cells[1]?.toLowerCase() === plan.name.toLowerCase());
  if (!row || row.length < 9) throw incompatibleTask(plan, new Error("Unrecognized task status"));
  return row[6] === taskRunning;
}
