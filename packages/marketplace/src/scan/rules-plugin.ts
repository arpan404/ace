import type { EntryRule } from "./rule.ts";
import type { ScanInput } from "./index.ts";

/*
 * The `plugin` check's rules (ADR 0174 §8): a plugin's declared commands and hosts against what
 * its files hold and do. A server or hook may only run files the plugin carries or programs
 * already on the machine, never fetch and install code when it starts, and never run install
 * scripts.
 */

type Hit = { path?: string; line?: number; message: string };
type Execution = Extract<
  NonNullable<ScanInput["inspection"]>,
  { type: "spade-plugin" }
>["executions"][number];

const executionsOf = (input: ScanInput): readonly Execution[] =>
  input.inspection?.type === "spade-plugin" ? input.inspection.executions : [];

const commandLine = (execution: Execution): string =>
  execution.kind === "hook"
    ? execution.command
    : execution.kind === "stdio"
      ? [execution.command, ...execution.args].join(" ")
      : "";

const label = (execution: Execution): string =>
  execution.kind === "hook" ? `Its ${execution.event} hook` : `Its server ${execution.name}`;

const roots = /^\$\{(?:PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|ACE_PLUGIN_ROOT)\}\/|^\.\//;

/** A package runner's argument that names an exact version: `pkg@1.2.3`, `@scope/pkg@1.2.3`. */
const pinnedNpm = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/i;
const pinnedPython = /^[A-Za-z0-9._-]+(?:\[[^\]]+\])?==\d+(?:\.\d+)*$/;

function unpinnedRunner(words: readonly string[]): string | undefined {
  const [program = "", ...rest] = words;
  const name = program.split("/").pop() ?? "";
  const target = rest.find((word) => !word.startsWith("-"));
  if (name === "npx" || name === "bunx" || name === "pnpx")
    return target && !pinnedNpm.test(target) ? target : undefined;
  if (
    (name === "pnpm" || name === "yarn" || name === "npm") &&
    ["dlx", "exec"].includes(rest[0] ?? "")
  ) {
    const spec = rest.slice(1).find((word) => !word.startsWith("-"));
    return spec && !pinnedNpm.test(spec) ? spec : undefined;
  }
  if (name === "uvx" || (name === "pipx" && rest[0] === "run")) {
    const spec = (name === "pipx" ? rest.slice(1) : rest).find((word) => !word.startsWith("-"));
    const from = rest[rest.indexOf("--from") + 1];
    const named = rest.includes("--from") ? from : spec;
    return named && !pinnedPython.test(named) ? named : undefined;
  }
  return undefined;
}

const installs: readonly RegExp[] = [
  /\b(?:pip3?|uv\s+pip|python3?\s+-m\s+pip)\s+install\b/,
  /\bnpm\s+(?:install|i|ci|add)\b|\b(?:yarn|pnpm|bun)\s+(?:add|install)\b/,
  /\bgem\s+install\b|\bcargo\s+install\b|\bgo\s+(?:install|get)\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b/,
  /\bgit\s+clone\b/,
  /\b(?:curl|wget)\b/,
];

const runtimeInstall: EntryRule = {
  kind: "entry",
  id: "runtime-install",
  check: "plugin",
  level: "block",
  find(input) {
    const hits: Hit[] = [];
    for (const execution of executionsOf(input)) {
      if (execution.kind === "remote") continue;
      const words =
        execution.kind === "stdio"
          ? [execution.command, ...execution.args]
          : execution.command.split(/\s+/);
      const unpinned = unpinnedRunner(words);
      if (unpinned)
        hits.push({
          message: `${label(execution)} downloads ${unpinned} when it starts, without a fixed version`,
        });
      else if (installs.some((pattern) => pattern.test(commandLine(execution))))
        hits.push({ message: `${label(execution)} installs code from the internet when it runs` });
    }
    return hits;
  },
};

const missingFile: EntryRule = {
  kind: "entry",
  id: "runs-missing-file",
  check: "plugin",
  level: "block",
  find(input) {
    const paths = new Set(input.files.map((file) => file.path));
    const hits: Hit[] = [];
    for (const execution of executionsOf(input)) {
      if (execution.kind === "remote") continue;
      const words =
        execution.kind === "stdio"
          ? [execution.command, ...execution.args]
          : execution.command.split(/\s+/);
      for (const word of words) {
        const own = roots.test(word) ? word.replace(roots, "") : undefined;
        const script =
          !own && /^[\w./-]+\.(?:js|mjs|cjs|ts|py|sh|rb|pl)$/.test(word) && !word.startsWith("/")
            ? word
            : undefined;
        const path = own ?? script;
        if (path && !paths.has(path))
          hits.push({ message: `${label(execution)} runs ${path}, which the plugin doesn't hold` });
      }
    }
    return hits;
  },
};

const installScripts: EntryRule = {
  kind: "entry",
  id: "install-script",
  check: "plugin",
  level: "block",
  find(input) {
    const hits: Hit[] = [];
    const decoder = new TextDecoder();
    for (const file of input.files) {
      if (/(?:^|\/)binding\.gyp$/.test(file.path))
        hits.push({ path: file.path, message: `${file.path} builds native code when installed` });
      if (/(?:^|\/)package\.json$/.test(file.path) && file.content.byteLength <= 1024 * 1024) {
        let scripts: unknown;
        try {
          scripts = (JSON.parse(decoder.decode(file.content)) as { scripts?: unknown }).scripts;
        } catch {
          scripts = undefined;
        }
        if (scripts && typeof scripts === "object")
          for (const name of ["preinstall", "install", "postinstall", "prepare", "prepublish"])
            if (name in scripts)
              hits.push({
                path: file.path,
                message: `${file.path} runs a ${name} script when installed`,
              });
      }
      if (
        /(?:^|\/)setup\.py$/.test(file.path) &&
        /\bcmdclass\s*=/.test(decoder.decode(file.content.subarray(0, 1024 * 1024)))
      )
        hits.push({ path: file.path, message: `${file.path} runs its own code when installed` });
    }
    return hits;
  },
};

const plainHttp: EntryRule = {
  kind: "entry",
  id: "plain-http-remote",
  check: "plugin",
  level: "block",
  find(input) {
    return executionsOf(input).flatMap((execution) =>
      execution.kind === "remote" && !execution.url.startsWith("https://")
        ? [
            {
              message: `Its server ${execution.name} is reached without encryption (${execution.url.slice(0, 120)})`,
            },
          ]
        : [],
    );
  },
};

const declaredHosts = (input: ScanInput): Set<string> => {
  const hosts = new Set<string>();
  for (const execution of executionsOf(input))
    if (execution.kind === "remote")
      try {
        hosts.add(new URL(execution.url).hostname.toLowerCase());
      } catch {
        // A URL that doesn't parse is the plain-http rule's to speak about.
      }
  return hosts;
};
const local =
  /^(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$|\.(?:invalid|example|test|localhost)$|^example\.(?:com|org|net)$/;

const undeclaredHosts: EntryRule = {
  kind: "entry",
  id: "undeclared-host",
  check: "plugin",
  level: "warn",
  find(input, facts) {
    if (input.type !== "spade-plugin") return [];
    const declared = declaredHosts(input);
    const seen = [...new Set(facts.hosts.map((host) => host.toLowerCase()))];
    return seen
      .filter((host) => !declared.has(host) && !local.test(host))
      .slice(0, 20)
      .map((host) => ({
        message: `Its code talks to ${host}, which its manifest doesn't declare`,
      }));
  },
};

const runsCommands: EntryRule = {
  kind: "entry",
  id: "runs-commands",
  check: "plugin",
  level: "note",
  strict: true,
  find(input) {
    const count = executionsOf(input).length;
    return count > 0
      ? [
          {
            message: `It runs ${count} command${count === 1 ? "" : "s"} or server${count === 1 ? "" : "s"} once accepted`,
          },
        ]
      : [];
  },
};

export const pluginRules: EntryRule[] = [
  runtimeInstall,
  missingFile,
  installScripts,
  plainHttp,
  undeclaredHosts,
  runsCommands,
];
