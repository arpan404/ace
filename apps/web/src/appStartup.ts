export type AppStartupState = "connecting" | "bootstrapping" | "ready";

export function resolveAppStartupState(input: {
  readonly bootstrapComplete: boolean;
  readonly hasNativeApi: boolean;
}): AppStartupState {
  if (!input.hasNativeApi) {
    return "connecting";
  }

  if (!input.bootstrapComplete) {
    return "bootstrapping";
  }

  return "ready";
}

export function resolveAppStartupMessage(state: AppStartupState, appDisplayName: string): string {
  switch (state) {
    case "connecting":
      return `Connecting to ${appDisplayName} server...`;
    case "bootstrapping":
      return `Loading ${appDisplayName}...`;
    case "ready":
      return `${appDisplayName} ready`;
  }
}
