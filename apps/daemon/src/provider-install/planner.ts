import { registryPrerequisites } from "./prerequisites.ts";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { findExecutable, parseVersion } from "@ace/provider-kit/discovery";
import { probeOutput } from "@ace/provider-kit/process";
import type {
  InstallAction,
  InstallAgent,
  InstallMethod,
  ProviderKind,
  ProviderInstallPlan,
} from "@ace/protocol";
import {
  installer,
  installerCommands,
  installCommand,
  type Installer,
} from "@ace/provider-kit/installers";

export interface InstallEnvironment {
  env: NodeJS.ProcessEnv;
  home: string;
  binaryPath?(provider: ProviderKind): string | undefined;
  probe?: typeof probeOutput;
  registry?: RegistryInstaller;
  writable?: (path: string) => Promise<boolean>;
}
export interface RegistryInstaller {
  plan(
    target: InstallTarget,
    action: InstallAction,
    signal?: AbortSignal,
  ): Promise<ProviderInstallPlan>;
  run(
    plan: ProviderInstallPlan,
    session: string,
    signal: AbortSignal,
    line: (text: string) => void,
  ): Promise<string>;
}
export interface InstallTarget {
  provider: ProviderKind;
  agent?: InstallAgent | undefined;
  acpAgentId?: string | undefined;
}
function within(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}
async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    try {
      await access(path);
      return false;
    } catch {
      const parent = dirname(path);
      return parent !== path && writable(parent);
    }
  }
}
export class InstallPlanner {
  private options: InstallEnvironment;
  constructor(options: InstallEnvironment) {
    this.options = options;
  }
  get registry(): RegistryInstaller | undefined {
    return this.options.registry;
  }
  get env(): NodeJS.ProcessEnv {
    return this.options.env;
  }
  async probe(
    binary: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const output = await (this.options.probe ?? probeOutput)(binary, args, {
        env: this.env,
        maxBytes: 262144,
        timeoutMs: 4000,
        ...(signal ? { signal } : {}),
      });
      return output.code === 0 ? output.stdout : undefined;
    } catch {
      return undefined;
    }
  }
  async plan(
    target: InstallTarget,
    action: InstallAction,
    requested?: InstallMethod,
    signal?: AbortSignal,
  ): Promise<ProviderInstallPlan> {
    if (target.acpAgentId && target.provider !== "acp") throw new Error("Invalid registry target");
    if (target.provider === "antigravity" || target.acpAgentId) {
      if (requested && requested !== "registry") throw new Error("Invalid registry installer");
      if (this.options.registry)
        return registryPrerequisites(await this.options.registry.plan(target, action, signal), {
          env: this.env,
          home: this.options.home,
          probe: (command, args) => this.probe(command, args, signal),
          writable: this.options.writable ?? writable,
        });
      return {
        ...target,
        action,
        status: "unavailable",
        methods: [],
        commands: [],
        needsAdmin: false,
        sourceUrl: "https://antigravity.google/docs/ide/extensions/zed",
        message: "The agent catalog is unavailable. Reconnect and try Install again.",
      };
    }
    const spec = installer(target.provider, target.agent);
    const base: ProviderInstallPlan = {
      provider: target.provider,
      ...(target.agent ? { agent: target.agent } : {}),
      action,
      status: "unavailable",
      methods: [],
      commands: [],
      sourceUrl: spec?.sourceUrl ?? "https://agentclientprotocol.com/get-started/agents",
      needsAdmin: false,
    };
    if (!spec)
      return {
        ...base,
        message:
          "Choose a reviewed ACP agent. Custom registry commands cannot be installed by this API.",
      };
    if (spec.manual)
      return {
        ...base,
        status: target.provider === "cursor" ? "sign_in" : "manual",
        message: spec.manual,
      };
    const [npmCandidate, bun, brew, curl, bash, rm, node, binary] = await Promise.all([
      ...["npm", "bun", "brew", "curl", "bash", "rm", "node"].map((name) =>
        findExecutable(name, this.env),
      ),
      findExecutable(this.options.binaryPath?.(target.provider) ?? spec.binary, this.env),
    ]);
    const nodeVersion =
      node &&
      parseVersion(
        "node",
        ((await this.probe(node, ["--version"], signal)) ?? "").replace(/^v/, ""),
      );
    const npm =
      nodeVersion &&
      (Number(nodeVersion.split(".")[0]) > (spec.nodeMajor ?? 16) ||
        (Number(nodeVersion.split(".")[0]) === (spec.nodeMajor ?? 16) &&
          Number(nodeVersion.split(".")[1]) >= (spec.nodeMinor ?? 0)))
        ? npmCandidate
        : undefined;
    const [npmRoot, brewPrefix, bunBin] = await Promise.all([
      npmCandidate && this.probe(npmCandidate, ["root", "-g"], signal),
      brew && this.probe(brew, ["--prefix"], signal),
      bun && this.probe(bun, ["pm", "bin", "-g"], signal),
    ]);
    const resolved = binary ? await realpath(binary).catch(() => binary) : undefined;
    const existing = resolved
      ? this.detect(spec, resolved, binary ?? resolved, { npmRoot, brewPrefix, bunBin })
      : undefined;
    const methods: InstallMethod[] = [];
    if (spec.package && (npm || (action === "uninstall" && npmCandidate))) methods.push("npm");
    if (spec.bun && bun) methods.push("bun");
    if (spec.brew && brew) methods.push("brew");
    if (spec.script && curl && bash) methods.push("script");
    const version =
      binary && parseVersion(spec.binary, (await this.probe(binary, ["--version"], signal)) ?? "");
    const result = { ...base, methods, ...(version ? { installedVersion: version } : {}) };
    if (binary && !existing)
      return {
        ...result,
        status: "manual",
        message:
          "The existing binary's installation method is unknown. Manage it through its original installer to avoid a duplicate.",
      };
    if (existing && requested && existing !== requested)
      return { ...result, message: "Use the existing installation method to avoid a duplicate." };
    if ((action === "update" || action === "uninstall") && !binary)
      return { ...result, message: "This CLI is not installed." };
    if (
      !npm &&
      spec.package &&
      brew &&
      brewPrefix &&
      action !== "uninstall" &&
      ((!binary && !methods.length) || existing === "npm")
    ) {
      const npmPath = join(brewPrefix.trim(), "bin", "npm");
      const verifyPath = join(brewPrefix.trim(), "bin", spec.binary);
      return {
        ...result,
        status: "ready",
        method: existing ?? "brew",
        methods: [existing ?? "brew"],
        prerequisite: { name: "Node.js", sourceUrl: "https://nodejs.org/en/download" },
        commands: [
          installCommand(brew, ["install", "node"]),
          ...installerCommands(spec, action, "npm", { npm: npmPath }, this.options.home),
        ],
        verify: installCommand(verifyPath, ["--version"]),
        needsAdmin: !(await (this.options.writable ?? writable)(brewPrefix.trim())),
        message: "Node.js and npm will be installed first using Homebrew.",
      };
    }
    if (
      spec.package &&
      !npm &&
      action !== "uninstall" &&
      ((!methods.length && !binary) || existing === "npm")
    )
      return {
        ...result,
        prerequisite: { name: "Node.js", sourceUrl: "https://nodejs.org/en/download" },
        message:
          "Install Node.js from its official download. It includes npm. Then retry Install here.",
      };
    if (!methods.length && spec.brew)
      return {
        ...result,
        prerequisite: { name: "Homebrew", sourceUrl: "https://brew.sh" },
        message:
          "This installer needs Homebrew. Install it using its official setup, which may require administrator approval, then retry here.",
      };
    const method = requested ?? existing ?? methods[0];
    if (!method || !methods.includes(method) || (existing && method !== existing))
      return {
        ...result,
        message:
          "Use the existing installation method. Its package manager must be available on PATH.",
      };
    const verifyPath =
      binary ??
      (method === "script" && spec.scriptHome
        ? join(this.options.home, spec.scriptHome)
        : spec.binary);
    const selected = { ...result, method, verify: installCommand(verifyPath, ["--version"]) };
    if (method === "script" && action === "uninstall" && !spec.scriptUninstall)
      return {
        ...selected,
        status: "manual",
        message:
          "The vendor does not document an automatic uninstall for this script installation. Follow the official source instructions.",
      };
    const commands = installerCommands(
      spec,
      action,
      method,
      {
        npm: npm ?? (action === "uninstall" ? npmCandidate : undefined),
        bun,
        brew,
        curl,
        bash,
        rm,
      },
      this.options.home,
    );
    const destination =
      method === "npm"
        ? npmRoot
        : method === "bun"
          ? bunBin
          : method === "brew"
            ? brewPrefix
            : dirname(verifyPath);
    if (!commands.length)
      return { ...selected, message: "Required installer executable is unavailable." };
    const destinations = destination ? [destination] : [];
    if (method === "npm" && npmRoot) {
      destinations.push(join(dirname(dirname(npmRoot)), "bin"));
      if (binary && spec.package) destinations.push(join(npmRoot, spec.package), dirname(binary));
    }
    if (resolved && binary) destinations.push(dirname(resolved));
    const permissions = await Promise.all(destinations.map(this.options.writable ?? writable));
    const needsAdmin = !destinations.length || permissions.some((permission) => !permission);
    return {
      ...selected,
      status: "ready",
      commands,
      needsAdmin,
      ...(needsAdmin
        ? {
            message:
              "This location requires administrator access. Ask the person to approve and run these commands in an ace terminal tab. ace never runs sudo.",
          }
        : {}),
    };
  }
  private detect(
    spec: Installer,
    path: string,
    link: string,
    roots: {
      npmRoot: string | undefined;
      brewPrefix: string | undefined;
      bunBin: string | undefined;
    },
  ): InstallMethod | undefined {
    if (
      spec.brew &&
      roots.brewPrefix &&
      ["Cellar", "Caskroom"].some((dir) =>
        within(path, join(roots.brewPrefix ?? "", dir, spec.brew?.name.split("/").at(-1) ?? "")),
      )
    )
      return "brew";
    if (spec.package && roots.npmRoot && within(path, join(roots.npmRoot, spec.package)))
      return "npm";
    if (
      spec.bun &&
      roots.bunBin &&
      (within(link, roots.bunBin) ||
        within(
          path,
          join(dirname(roots.bunBin), "install", "global", "node_modules", spec.package ?? ""),
        ))
    )
      return "bun";
    if (spec.scriptHome && link === join(this.options.home, spec.scriptHome)) return "script";
    return undefined;
  }
  async verify(plan: ProviderInstallPlan, signal?: AbortSignal): Promise<string | undefined> {
    if (!plan.verify) return undefined;
    const path = await findExecutable(plan.verify.command, this.env);
    if (plan.action === "uninstall") {
      const spec = installer(plan.provider, plan.agent);
      const remaining = spec && (await findExecutable(spec.binary, this.env));
      return path || remaining ? undefined : "removed";
    }
    if (!path) return undefined;
    return parseVersion(plan.provider, (await this.probe(path, plan.verify.args, signal)) ?? "");
  }
}
