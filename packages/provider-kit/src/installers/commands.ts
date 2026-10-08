import type { InstallAction, InstallCommand, InstallMethod } from "@ace/protocol";
import type { Installer } from "./manifest.ts";

function quote(word: string): string {
  return /^[A-Za-z0-9_@./:=+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}
export function installCommand(executable: string, args: readonly string[] = []): InstallCommand {
  return {
    command: executable,
    args: [...args],
    display: [executable, ...args].map(quote).join(" "),
  };
}
export interface InstallerExecutables {
  npm?: string | undefined;
  bun?: string | undefined;
  brew?: string | undefined;
  curl?: string | undefined;
  bash?: string | undefined;
  rm?: string | undefined;
}
/** Freshly build only reviewed commands; all paths come from the trusted planning boundary. */
export function installerCommands(
  spec: Installer,
  action: InstallAction,
  method: InstallMethod,
  executables: InstallerExecutables,
  home: string,
): InstallCommand[] {
  const { npm, bun, brew, curl, bash, rm } = executables;
  if (method === "npm" && npm && spec.package)
    return [
      installCommand(
        npm,
        action === "uninstall"
          ? ["uninstall", "-g", spec.package]
          : ["install", "-g", ...(spec.npmFlags ?? []), `${spec.package}@latest`],
      ),
    ];
  if (method === "bun" && bun && spec.bun && spec.package)
    return [
      installCommand(
        bun,
        action === "uninstall"
          ? ["remove", "-g", spec.package]
          : ["install", "-g", "--trust", spec.package],
      ),
    ];
  if (method === "brew" && brew && spec.brew)
    return [
      installCommand(brew, [
        action === "update" ? "upgrade" : action === "uninstall" ? "uninstall" : "install",
        ...(spec.brew.cask ? ["--cask"] : []),
        spec.brew.name,
      ]),
    ];
  if (method === "script" && bash && curl && spec.script) {
    if (action === "uninstall")
      return rm && spec.scriptUninstall
        ? spec.scriptUninstall.map(([flag, path]) =>
            installCommand(rm, [flag, "--", `${home.replace(/\/$/, "")}/${path}`]),
          )
        : [];
    return [
      installCommand(bash, [
        "-o",
        "pipefail",
        "-c",
        `${installCommand(curl, ["-fsSL", spec.script]).display} | ${installCommand(bash).display}`,
      ]),
    ];
  }
  return [];
}
