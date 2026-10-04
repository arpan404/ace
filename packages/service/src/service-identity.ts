import { z } from "zod";
import type { ServicePlan } from "./plan.ts";

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
      if (rows.size !== properties.length || properties.some((key) => !rows.has(key)))
        throw new Error("Missing loaded service properties");
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
