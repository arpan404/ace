interface ElectronEnvironmentLike {
  readonly desktopBridge?: unknown;
  readonly location?: {
    readonly protocol?: string;
  };
  readonly navigator?: {
    readonly userAgent?: string;
  };
}

export function detectElectronEnvironment(environment: ElectronEnvironmentLike | null): boolean {
  if (!environment) {
    return false;
  }

  if (environment.desktopBridge !== undefined) {
    return true;
  }

  if (environment.location?.protocol === "ace:") {
    return true;
  }

  return (environment.navigator?.userAgent ?? "").includes("Electron/");
}

export const isElectron = detectElectronEnvironment(typeof window !== "undefined" ? window : null);
