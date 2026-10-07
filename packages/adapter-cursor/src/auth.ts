import { CursorHost, discoverCursorSdk, type HostOptions } from "./host.ts";
import { CursorInstance, cursorSdkEnvironment } from "./instance.ts";
import { CursorHostSlots } from "./slots.ts";
import { SafeAuth, sdkVersion } from "./contracts.ts";

/** Discovery failure is not a rejected sign-in. Keep provider diagnostics off the auth wire. */
export class CursorSdkUnavailableError extends Error {
  constructor() {
    super("Cursor SDK backend is unavailable");
    this.name = "CursorSdkUnavailableError";
  }
}

export interface CursorAccountDriverOptions extends Omit<HostOptions, "env" | "cwd"> {
  launchEnv: NodeJS.ProcessEnv;
  /** Accounts owns credential-key filtering; this runs only for its selected home. */
  environment?(instance: CursorInstance): NodeJS.ProcessEnv;
  /** Must fence sends, await admissions/hosts, and retain reservations on failed exit. */
  stopInstance(id: string): Promise<void>;
}
const reserve = (kind: "login" | "logout") => {
  const completion = Promise.withResolvers<void>();
  return {
    kind,
    controller: new AbortController(),
    done: completion.promise,
    finish: completion.resolve,
  };
};

/** Official SDK auth seam for AccountService. It never handles a key-bearing value. */
export function createCursorAccountDriver(options: CursorAccountDriverOptions) {
  const checkAvailability = async () => {
    const installed = await discoverCursorSdk(options.discovery);
    if (!installed.supported)
      throw Object.assign(new CursorSdkUnavailableError(), {
        code:
          installed.version && installed.version !== sdkVersion ? "cli_too_old" : "not_configured",
      });
  };
  const slots = options.slots ?? new CursorHostSlots(2);
  let workers = 0;
  const changingAuth = new Map<
    string,
    {
      kind: "login" | "logout";
      controller: AbortController;
      done: Promise<void>;
      finish(): void;
    }
  >();
  const operate = async (
    instance: CursorInstance,
    method: "status" | "login" | "logout" | "models",
    signal: AbortSignal,
    loginUrl?: (url: string) => void,
  ) => {
    signal.throwIfAborted();
    await checkAvailability();
    if (method !== "logout" && method !== "login" && changingAuth.has(instance.id))
      throw new Error("SDK authentication change is fencing this instance");
    if (workers >= 2) throw new Error("SDK account worker capacity reached");
    workers++;
    let host: CursorHost | undefined;
    try {
      host = new CursorHost(
        {
          ...options,
          slots,
          instanceId: instance.id,
          env: cursorSdkEnvironment(instance, options.environment?.(instance) ?? options.launchEnv),
        },
        () => {
          throw new Error("Auth workers must not emit captured frames");
        },
        loginUrl,
      );
      const abort = () => {
        void host?.stop();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        return await host.request(method, undefined, method === "login" ? 300000 : undefined);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } finally {
      await host?.stop();
      workers--;
    }
  };
  return {
    checkAvailability,
    async status(instance: CursorInstance, signal: AbortSignal) {
      return SafeAuth.parse(await operate(CursorInstance.parse(instance), "status", signal));
    },
    async login(
      instance: CursorInstance,
      signal: AbortSignal,
      authorizedEphemeralUrl: (url: string) => void,
    ) {
      const selected = CursorInstance.parse(instance);
      if (changingAuth.has(selected.id) || changingAuth.size >= 2)
        throw new Error("SDK authentication change already in flight or at capacity");
      const change = reserve("login");
      changingAuth.set(selected.id, change);
      try {
        await options.stopInstance(selected.id);
        await slots.stopInstance(selected.id);
        return SafeAuth.parse(
          await operate(
            selected,
            "login",
            AbortSignal.any([signal, change.controller.signal]),
            authorizedEphemeralUrl,
          ),
        );
      } finally {
        if (changingAuth.get(selected.id) === change) changingAuth.delete(selected.id);
        change.finish();
      }
    },
    async logout(instance: CursorInstance, signal: AbortSignal) {
      const selected = CursorInstance.parse(instance);
      const previous = changingAuth.get(selected.id);
      if (previous?.kind === "logout" || (!previous && changingAuth.size >= 2))
        throw new Error("SDK sign-out already in flight or at capacity");
      const change = reserve("logout");
      changingAuth.set(selected.id, change);
      try {
        // Abort the browser exchange and wait for its host exit before deleting the store.
        previous?.controller.abort();
        await previous?.done;
        await options.stopInstance(selected.id);
        await slots.stopInstance(selected.id);
        return SafeAuth.parse(await operate(selected, "logout", signal));
      } finally {
        if (changingAuth.get(selected.id) === change) changingAuth.delete(selected.id);
        change.finish();
      }
    },
    models(instance: CursorInstance, signal: AbortSignal) {
      return operate(CursorInstance.parse(instance), "models", signal);
    },
  };
}
