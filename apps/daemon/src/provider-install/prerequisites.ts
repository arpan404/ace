import { join } from "node:path";
import { InstallAgent, type ProviderInstallPlan } from "@ace/protocol";
import { findExecutable, parseVersion } from "@ace/provider-kit/discovery";
import { installCommand, installer } from "@ace/provider-kit/installers";

interface Environment {
  env: NodeJS.ProcessEnv;
  home: string;
  probe(command: string, args: readonly string[]): Promise<string | undefined>;
  writable(path: string): Promise<boolean>;
}

/** Bootstrap only documented prerequisites, then re-plan the registry install. */
export async function registryPrerequisites(
  plan: ProviderInstallPlan,
  environment: Environment,
): Promise<ProviderInstallPlan> {
  let prerequisite = plan.prerequisite;
  if (plan.registryPlan?.runtime === "npm") {
    const node = await findExecutable("node", environment.env);
    const version =
      node &&
      parseVersion(
        "node",
        ((await environment.probe(node, ["--version"])) ?? "").replace(/^v/, ""),
      );
    const agent = InstallAgent.safeParse(plan.acpAgentId?.replace(/^official:/, ""));
    const spec = agent.success ? installer("acp", agent.data) : undefined;
    if (!version || Number(version.split(".")[0]) < (spec?.nodeMajor ?? 16))
      prerequisite = { name: "Node.js", sourceUrl: "https://nodejs.org/en/download" };
  }
  if (!prerequisite) return plan;
  const base = { ...plan, registryPlan: undefined, status: "unavailable" as const, prerequisite };
  if (prerequisite.name === "Node.js") {
    const brew = await findExecutable("brew", environment.env);
    const prefix = brew && (await environment.probe(brew, ["--prefix"]))?.trim();
    if (brew && prefix)
      return {
        ...base,
        status: "ready",
        method: "registry",
        methods: ["registry"],
        commands: [installCommand(brew, ["install", "node"])],
        needsAdmin: !(await environment.writable(prefix)),
        message: "Node.js and npm will be installed first using Homebrew.",
      };
    return {
      ...base,
      message:
        "Install Node.js from its official download. It includes npm. Then retry Install here.",
    };
  }
  if (prerequisite.name !== "uv") return base;
  const [curl, bash, sh, env] = await Promise.all(
    ["curl", "bash", "sh", "env"].map((name) => findExecutable(name, environment.env)),
  );
  if (!curl || !bash || !sh || !env)
    return { ...base, message: "Install uv using its official setup, then retry Install here." };
  const destination = join(environment.home, ".local", "bin");
  return {
    ...base,
    status: "ready",
    method: "registry",
    methods: ["registry"],
    commands: [
      installCommand(bash, [
        "-o",
        "pipefail",
        "-c",
        `${installCommand(curl, ["-LsSf", "https://astral.sh/uv/install.sh"]).display} | ${installCommand(env, [`UV_INSTALL_DIR=${destination}`, "UV_NO_MODIFY_PATH=1", sh]).display}`,
      ]),
    ],
    needsAdmin: !(await environment.writable(destination)),
    message: "uv will be installed first using its official installer.",
  };
}
