import {
  PackageCodeImport,
  type PackageCode,
  type PackageEffect,
  type Recipe,
} from "@ace/protocol/marketplace";
import { refusal, type Refusal, type RuleId } from "./rules.ts";

/*
 * A package's own code (ADR 0203): the WebAssembly components `bot.json` names under `code`,
 * read the way Spade reads them (`spade_core::package::code`), with the same sentences, which
 * the conformance suite's `code` part (`spade/spec/conformance/code/`) holds both readers to. The Worker runs TypeScript and so checks only a component's
 * header, its size and the manifest's list; what the binary really imports is read by Spade's
 * program on the signer (`spade --code-check`) and on the device, which hold it to this list.
 * Pure.
 */

/** At most this many components in a package, each at most 8 MiB. */
export const mostComponents = 4;
export const mostComponentBytes = 8 * 1024 * 1024;
/** The world this build runs, and those Spade's interface defines for later phases. */
export const codeWorld = "spade:package/bot-tools@1.0.0";
const laterWorlds = new Set([
  "spade:package/bot-contracts@1.0.0",
  "spade:package/bot-checks@1.0.0",
  "spade:package/bot-cards@1.0.0",
]);

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Why an import outside Spade's world is refused, as Spade says it. */
export function outsideWorld(name: string): string {
  const base = name.split("@")[0] ?? name;
  if (base.startsWith("wasi:filesystem") || base.startsWith("wasi:sockets"))
    return `${name}: code has no file system or sockets; files come through spade:package/tools, under the gate`;
  if (base.startsWith("wasi:cli"))
    return `${name}: code has no environment, arguments or standard streams`;
  if (base.startsWith("wasi:http"))
    return `${name}: code makes requests only with spade:package/http, through Spade`;
  if (base.includes("thread")) return `${name}: code runs without threads`;
  return `${name} is outside Spade's world (spade:package@1.0.0)`;
}

const reachesHosts = (effect: unknown) => {
  const entry = record(effect);
  return (
    entry?.["effect"] === "network" && Array.isArray(entry["hosts"]) && entry["hosts"].length > 0
  );
};

function bound(
  at: string,
  entry: Record<string, unknown>,
  field: "timeout_s" | "memory_mb",
  most: number,
): Refusal[] {
  const value = entry[field];
  if (value === undefined) return [];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= most
    ? []
    : [refusal("code.bound", `${at}.${field} is a whole number from 1 to ${most}`)];
}

/** Every problem with `bot.json`'s `code`, given its declared `effects` as written. */
export function codeProblems(raw: unknown, effects: readonly unknown[]): Refusal[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > mostComponents)
    return [refusal("code.list", `code is a list of at most ${mostComponents} components`)];
  const found: Refusal[] = [];
  const refuse = (rule: RuleId, message: string) => {
    found.push(refusal(rule, message));
  };
  const names = new Set<string>();
  raw.forEach((item, index) => {
    const at = `code[${index}]`;
    const entry = record(item);
    if (!entry) {
      refuse("code.field", `${at} is an object`);
      return;
    }
    const name = typeof entry["name"] === "string" ? entry["name"] : "";
    if (!/^[a-z][a-z0-9]{0,23}$/.test(name))
      refuse(
        "code.name",
        `${at}.name is 1 to 24 lower-case letters and digits, starting with a letter`,
      );
    if (names.has(name)) refuse("code.name-unique", `${at}: each component has a name of its own`);
    names.add(name);
    if (entry["file"] !== `code/${name}.wasm`)
      refuse(
        "code.file",
        `${at}.file is code/${name}.wasm: a component, never precompiled code (.cwasm)`,
      );
    const world = entry["world"];
    if (typeof world === "string" && laterWorlds.has(world))
      refuse(
        "code.world-later",
        `Needs a newer Spade: this one runs code built for ${codeWorld} only, not ${world}`,
      );
    else if (world !== codeWorld) refuse("code.world", `${at}.world is ${codeWorld}`);
    const imports = entry["imports"];
    if (!Array.isArray(imports))
      refuse("code.imports", `${at}.imports lists what the component imports, [] for nothing`);
    else {
      const seen = new Set<string>();
      for (const imported of imports) {
        if (typeof imported !== "string") {
          refuse("code.imports", `${at}.imports names interfaces`);
          continue;
        }
        if (!PackageCodeImport.safeParse(imported).success) {
          refuse("code.import", `${at}: ${outsideWorld(imported)}`);
          continue;
        }
        if (seen.has(imported))
          refuse("code.import-twice", `${at}.imports lists ${imported} twice`);
        seen.add(imported);
      }
      if (seen.has("spade:package/http") && !effects.some(reachesHosts))
        refuse(
          "code.http-network",
          `${at} imports spade:package/http, which needs a declared network effect naming its hosts`,
        );
    }
    const why = entry["why"];
    if (typeof why !== "string" || !why.trim() || why.trim().length > 500)
      refuse("code.why", `${at}.why says in a sentence what its code does`);
    found.push(...bound(at, entry, "timeout_s", 300), ...bound(at, entry, "memory_mb", 512));
  });
  return found;
}

/** What a component file's first bytes are: a component, a core module, or neither. */
export function wasmKind(bytes: Uint8Array): "component" | "module" | "other" {
  const wasm = bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
  if (!wasm || bytes.length < 8) return "other";
  // The version word: 1 for a core module; a component's layer 1 is `0d 00 01 00`.
  if (bytes[4] === 0x01 && bytes[5] === 0x00 && bytes[6] === 0x00 && bytes[7] === 0x00)
    return "module";
  if (bytes[4] === 0x0d && bytes[5] === 0x00 && bytes[6] === 0x01 && bytes[7] === 0x00)
    return "component";
  return "other";
}

/** Why the bytes at `path` can't be a package's component, or undefined. */
export function componentProblem(path: string, bytes: Uint8Array): string | undefined {
  if (bytes.length > mostComponentBytes) return `${path} is larger than 8 MiB`;
  switch (wasmKind(bytes)) {
    case "component":
      return undefined;
    case "module":
      return `${path} is a core WebAssembly module; Spade runs only components built for its world`;
    case "other":
      return `${path} isn't a WebAssembly component; precompiled code (.cwasm or any native file) is never accepted, Spade compiles the component itself`;
  }
}

/** Whether `path` may sit under a package's `code/`: a named component, its sources, its build. */
export function codeFileAllowed(path: string, recipe: Recipe | undefined): boolean {
  if (path === "code/build.json" || path.startsWith("code/src/")) return true;
  return (recipe?.code ?? []).some((code) => code.file === path);
}

/**
 * The install review's row for one component, as Spade writes it (`code::review_row`). It reads
 * the manifest's imports, which the signer and the device hold to the binary's own list.
 */
export function codeReviewRow(code: PackageCode, effects: readonly PackageEffect[]): string {
  const can: string[] = [];
  if (code.imports.includes("spade:package/http")) {
    const hosts = effects.flatMap((effect) =>
      effect.effect === "network" && effect.hosts ? effect.hosts : [],
    );
    can.push(`reach ${hosts.join(", ")}`);
  }
  if (code.imports.includes("spade:package/tools")) can.push("call Spade's tools as this bot");
  if (code.imports.includes("spade:package/kv")) can.push("keep a small store on this bot");
  const last = can.pop();
  const reach =
    last === undefined
      ? "It reaches nothing outside itself."
      : can.length === 0
        ? `It can ${last}.`
        : `It can ${can.join(", ")} and ${last}.`;
  return `Runs its own code: ${code.name}. ${reach}`;
}
