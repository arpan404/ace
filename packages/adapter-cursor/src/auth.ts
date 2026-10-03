import { CursorHost, discoverCursorSdk, type HostOptions } from "./host.ts";
import { CursorInstance, cursorSdkEnvironment } from "./instance.ts";
import { CursorHostSlots } from "./slots.ts";
import { SafeAuth } from "./contracts.ts";

export interface CursorAccountDriverOptions extends Omit<HostOptions, "env" | "cwd"> {
  launchEnv: NodeJS.ProcessEnv;
  /** Must fence sends, await admissions/hosts, and retain reservations on failed exit. */
  stopInstance(id: string): Promise<void>;
}
/** Official SDK auth seam for AccountService. It never handles a key-bearing value. */
export function createCursorAccountDriver(options: CursorAccountDriverOptions) {
  const slots = options.slots ?? new CursorHostSlots(2);
  let workers = 0;
  const signingOut = new Set<string>();
  const operate = async (
    instance: CursorInstance,
    method: "status" | "login" | "logout" | "models",
    signal: AbortSignal,
    loginUrl?: (url: string) => void,
  ) => {
    signal.throwIfAborted();
    const installed = await discoverCursorSdk(options.discovery);
    if (!installed.supported) throw new Error(installed.error ?? "Cursor SDK missing");
    if (method !== "logout" && signingOut.has(instance.id))
      throw new Error("SDK sign-out is fencing this instance");
    if (workers >= 2) throw new Error("SDK account worker capacity reached");
    workers++;
    let host: CursorHost | undefined;
    try {
      host = new CursorHost(
        {
          ...options,
          slots,
          instanceId: instance.id,
          env: cursorSdkEnvironment(instance, options.launchEnv),
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
    async status(instance: CursorInstance, signal: AbortSignal) {
      return SafeAuth.parse(await operate(CursorInstance.parse(instance), "status", signal));
    },
    async login(
      instance: CursorInstance,
      signal: AbortSignal,
      authorizedEphemeralUrl: (url: string) => void,
    ) {
      return SafeAuth.parse(
        await operate(CursorInstance.parse(instance), "login", signal, authorizedEphemeralUrl),
      );
    },
    async logout(instance: CursorInstance, signal: AbortSignal) {
      const selected = CursorInstance.parse(instance);
      if (signingOut.has(selected.id) || signingOut.size >= 2)
        throw new Error("SDK sign-out already in flight or at capacity");
      signingOut.add(selected.id);
      try {
        await options.stopInstance(selected.id);
        await slots.stopInstance(selected.id);
        return SafeAuth.parse(await operate(selected, "logout", signal));
      } finally {
        signingOut.delete(selected.id);
      }
    },
    models(instance: CursorInstance, signal: AbortSignal) {
      return operate(CursorInstance.parse(instance), "models", signal);
    },
  };
}
