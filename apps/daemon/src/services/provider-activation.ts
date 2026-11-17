/**
 * Provider activation runs after the engine has started (ADR 0175). Reading provider CLIs, the
 * Cursor SDK and ace's skill folder waits on other programs and the disk, which can be slow or
 * stuck. Only the provider that needs them waits, never the daemon's start.
 */
export type ActivationState =
  | { state: "starting" }
  | { state: "ready" }
  | { state: "degraded"; error: string };

export interface ActivationSteps<SkillRoots> {
  signal: AbortSignal;
  /**
   * Records which skill folders the last run left. It runs before `bind`, so before any
   * session can open and create a new folder.
   */
  captureSkillRoots(): Promise<SkillRoots>;
  /** Registers each provider's adapter as its CLI is read. */
  discover(): Promise<void>;
  /** Binds every registered adapter. It runs even when discovery failed partway. */
  bind(): Promise<void>;
  /** A step that failed without stopping activation (a skill folder that could not be read). */
  report?(error: unknown): void;
}

export interface ProviderActivation<SkillRoots> {
  /** Settles when activation ends, however it ends; never rejects. Sessions wait on it. */
  settled: Promise<void>;
  /** The skill folders captured, or undefined when they could not be read. */
  skillRoots: Promise<SkillRoots | undefined>;
  state(): ActivationState;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function activateProviders<SkillRoots>(
  steps: ActivationSteps<SkillRoots>,
): ProviderActivation<SkillRoots> {
  let current: ActivationState = { state: "starting" };
  const skillRoots = Promise.resolve()
    .then(() => steps.captureSkillRoots())
    .catch((error: unknown) => {
      steps.report?.(error);
      return undefined;
    });
  const settled = skillRoots.then(async () => {
    try {
      await discoverThenBind(steps);
      current = { state: "ready" };
    } catch (failure) {
      current = steps.signal.aborted
        ? { state: "ready" }
        : { state: "degraded", error: `Provider discovery failed: ${message(failure)}` };
    }
  });
  return { settled, skillRoots, state: () => current };
}

/**
 * One provider read, at startup or when a provider is enabled later: discovery, then binding
 * of whatever it registered, even when discovery failed partway, since an adapter left unbound
 * would open sessions without its accounts or ace's tools, and the registry having it stops a
 * later rediscovery. Rejects afterwards with discovery's failure, or else binding's.
 */
export async function discoverThenBind(
  steps: Pick<ActivationSteps<unknown>, "signal" | "discover" | "bind">,
): Promise<void> {
  let failure: unknown;
  let failed = false;
  try {
    steps.signal.throwIfAborted();
    await steps.discover();
  } catch (error) {
    failure = error;
    failed = true;
  }
  try {
    if (!steps.signal.aborted) await steps.bind();
  } catch (error) {
    if (!failed) failure = error;
    failed = true;
  }
  if (failed) throw failure;
}

/** The engine's own state: starting until providers are read and recovery has run. */
export function engineReadiness(
  activation: Pick<ProviderActivation<unknown>, "state">,
  recovered: Promise<void>,
): () => ActivationState {
  let recovery: ActivationState = { state: "starting" };
  recovered.then(
    () => {
      recovery = { state: "ready" };
    },
    (error: unknown) => {
      recovery = { state: "degraded", error: `Thread recovery failed: ${message(error)}` };
    },
  );
  return () => {
    const providers = activation.state();
    if (recovery.state === "degraded") return recovery;
    if (providers.state !== "ready") return providers;
    return recovery;
  };
}
