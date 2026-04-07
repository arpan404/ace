import type { DesktopCliInstallState } from "@ace/contracts";
import {
  resolveAceCliBinDir,
  resolveAceCliCommandPath,
  resolveAceCliPathTargets,
  type AceCliInstallResult,
  type AceCliInstallStatus,
} from "@ace/shared/cliInstall";

type DesktopCliInstallMetadataInput = {
  readonly baseDir: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly shell?: string;
};

function resolveDesktopCliInstallMetadata(input: DesktopCliInstallMetadataInput) {
  const binDir = resolveAceCliBinDir({
    baseDir: input.baseDir,
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
  });
  const platform = input.platform ?? process.platform;

  return {
    binDir,
    commandPath: resolveAceCliCommandPath(binDir, platform),
    pathTargets: resolveAceCliPathTargets({
      baseDir: input.baseDir,
      platform,
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
      ...(input.shell !== undefined ? { shell: input.shell } : {}),
    }),
  };
}

export function createUnsupportedDesktopCliInstallState(
  input: DesktopCliInstallMetadataInput & {
    readonly checkedAt?: string | null;
    readonly message: string;
  },
): DesktopCliInstallState {
  const metadata = resolveDesktopCliInstallMetadata(input);

  return {
    status: "unsupported",
    ...metadata,
    checkedAt: input.checkedAt ?? null,
    restartRequired: false,
    message: input.message,
  };
}

export function createPendingDesktopCliInstallState(
  input: DesktopCliInstallMetadataInput & {
    readonly status: Extract<DesktopCliInstallState["status"], "checking" | "installing">;
    readonly checkedAt?: string | null;
    readonly message?: string | null;
  },
): DesktopCliInstallState {
  const metadata = resolveDesktopCliInstallMetadata(input);

  return {
    status: input.status,
    ...metadata,
    checkedAt: input.checkedAt ?? null,
    restartRequired: false,
    message: input.message ?? null,
  };
}

export function createDesktopCliInstallStateFromInspect(
  installState: Pick<AceCliInstallStatus, "binDir" | "commandPath" | "pathTargets" | "ready">,
  input: {
    readonly checkedAt: string;
    readonly restartRequired?: boolean;
    readonly message?: string | null;
    readonly status?: Extract<DesktopCliInstallState["status"], "missing" | "ready" | "error">;
  },
): DesktopCliInstallState {
  return {
    status: input.status ?? (installState.ready ? "ready" : "missing"),
    binDir: installState.binDir,
    commandPath: installState.commandPath,
    pathTargets: [...installState.pathTargets],
    checkedAt: input.checkedAt,
    restartRequired: input.restartRequired ?? false,
    message: input.message ?? null,
  };
}

export function createDesktopCliInstallStateFromResult(
  installState: AceCliInstallResult,
  input: {
    readonly checkedAt: string;
    readonly message?: string | null;
    readonly status?: Extract<DesktopCliInstallState["status"], "missing" | "ready" | "error">;
  },
): DesktopCliInstallState {
  return createDesktopCliInstallStateFromInspect(installState, {
    checkedAt: input.checkedAt,
    restartRequired: installState.restartRequired,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  });
}
