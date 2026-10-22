/**
 * `SandboxNotice` from the desktop's preload (apps/desktop/src/shared/contract.ts): Chromium's
 * sandbox setup on a Linux AppImage or tar.gz. Read leniently; anything unexpected is hidden.
 */
export type SandboxNotice =
  | { state: "hidden" }
  | { state: "offer" | "working" | "restart"; sentence: string }
  | { state: "commands"; sentence: string; commands: string };

export function parseSandboxNotice(value: unknown): SandboxNotice {
  if (typeof value !== "object" || value === null) return { state: "hidden" };
  const state: unknown = Reflect.get(value, "state");
  const sentence: unknown = Reflect.get(value, "sentence");
  if (typeof sentence !== "string" || sentence.length === 0 || sentence.length > 400)
    return { state: "hidden" };
  if (state === "offer" || state === "working" || state === "restart") return { state, sentence };
  const commands: unknown = Reflect.get(value, "commands");
  if (state === "commands" && typeof commands === "string" && commands.length <= 20_000)
    return { state, sentence, commands };
  return { state: "hidden" };
}

export interface SandboxBridge {
  current(): Promise<SandboxNotice>;
  setup(): Promise<SandboxNotice>;
  hide(): Promise<SandboxNotice>;
  restart(): Promise<void>;
  /** Agents a restart would stop: null when the daemon could not say. */
  busy(): Promise<number | null>;
  onStatus(listener: (notice: SandboxNotice) => void): () => void;
}

/** `target[name]` bound to `target`, when it is a function. */
function method(target: unknown, name: string) {
  const value: unknown = typeof target === "object" && target ? Reflect.get(target, name) : null;
  return typeof value === "function"
    ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
    : undefined;
}
async function notice(call: () => unknown): Promise<SandboxNotice> {
  return parseSandboxNotice(await call());
}

/** `window.ace.sandbox`, or undefined outside the desktop app (or in an older one). */
export function desktopSandbox(scope: object = globalThis): SandboxBridge | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (typeof ace !== "object" || ace === null) return undefined;
  const sandbox: unknown = Reflect.get(ace, "sandbox");
  const updates: unknown = Reflect.get(ace, "updates");
  if (typeof sandbox !== "object" || sandbox === null) return undefined;
  const [current, setup, hide, restart, onStatus] = [
    "current",
    "setup",
    "hide",
    "restart",
    "onStatus",
  ].map((name) => method(sandbox, name));
  if (!current || !setup || !hide || !restart || !onStatus) return undefined;
  const busy = method(updates, "busy");
  return {
    current: () => notice(current),
    setup: () => notice(setup),
    hide: () => notice(hide),
    restart: async () => {
      await restart();
    },
    busy: async () => {
      const count: unknown = busy ? await busy() : null;
      return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
    },
    onStatus: (listener) => {
      const stop = onStatus((value: unknown) => listener(parseSandboxNotice(value)));
      return () => {
        if (typeof stop === "function") stop();
      };
    },
  };
}
