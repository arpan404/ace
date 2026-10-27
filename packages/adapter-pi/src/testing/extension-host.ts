import type { PiExtensionApi } from "../extension-api.ts";

type Tool = Parameters<PiExtensionApi["registerTool"]>[0];
type Command = Parameters<PiExtensionApi["registerCommand"]>[1];
type Factory = (pi: PiExtensionApi) => unknown;

const notInitialized =
  "Extension runtime not initialized. Action methods cannot be called during extension loading.";

/**
 * Synthetic host for a Pi extension, following Pi's documented lifecycle: the factory runs in a
 * loading phase where action methods throw and a factory failure is fatal; then the runtime
 * binds and `session_start` handlers run, where a failure is only reported as an extension
 * error. Registering a `direct` or `model-only` tool activates it, as Pi 1.4.0 does.
 */
export function createPiExtensionHost(
  options: {
    activeTools?: readonly string[];
    /**
     * Pi's `--tools` allowlist (exact names or `*` patterns). As in Pi 1.4.0 it filters extension
     * tools too: a tool outside it is never registered, so the model can't see or call it.
     */
    allowedTools?: readonly string[];
    appendEntry?: (customType: string, data: unknown) => void;
    onActiveToolsChange?: () => void;
  } = {},
) {
  const patterns = options.allowedTools?.map(
    (entry) =>
      new RegExp(
        `^${entry
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ),
  );
  const allowed = (name: string) =>
    !patterns || name.startsWith("mcp__") || patterns.some((pattern) => pattern.test(name));
  let phase: "loading" | "active" | "failed" = "loading";
  const native = new Set(options.activeTools ?? []);
  let active = [...native];
  const handlers = new Map<string, unknown[]>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const sent: unknown[] = [];
  const errors: { event: string; error: string }[] = [];
  const notices: string[] = [];
  const action = <T>(run: () => T): T => {
    if (phase !== "active") throw new Error(notInitialized);
    return run();
  };
  const registration = () => {
    if (phase === "failed") throw new Error("Extension failed to load and its API is inactive.");
  };
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    getContextUsage: () => undefined,
    sessionManager: { getLeafId: () => null },
    ui: {
      notify(message: string) {
        notices.push(message);
      },
      async confirm() {
        return false;
      },
    },
  };
  const api: PiExtensionApi = {
    on(event: string, handler: unknown) {
      registration();
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, command) {
      registration();
      commands.set(name, command);
    },
    registerTool(tool) {
      registration();
      if (!allowed(tool.name)) return;
      tools.set(tool.name, tool);
      const declared = (tool.exposure ?? "direct") === "direct" || tool.exposure === "model-only";
      if (declared && !active.includes(tool.name)) active = [...active, tool.name];
    },
    appendEntry: (customType, data) => action(() => options.appendEntry?.(customType, data)),
    sendMessage: (message) => action(() => void sent.push(message)),
    getActiveTools: () => action(() => [...active]),
    setActiveTools: (names) =>
      action(() => {
        active = names.filter((name) => tools.has(name) || native.has(name));
        options.onActiveToolsChange?.();
      }),
  };
  /** Runs every handler for an event in registration order; a throwing handler is reported. */
  const emit = async (event: string, payload: unknown = {}): Promise<unknown> => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      if (typeof handler !== "function") continue;
      try {
        result = await Reflect.apply(handler, undefined, [payload, ctx]);
      } catch (error) {
        errors.push({ event, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  };
  return {
    api,
    tools,
    commands,
    sent,
    errors,
    notices,
    active: () => [...active],
    /**
     * The tools Pi's codemode scripts may call (`ctx.executeTool()`, Pi 1.4.0): active `direct`
     * tools and every registered `codemode` or `deferred` tool. Pi appends a script-call note to
     * each declared one while codemode is active, and hides them all with `codemode.mode: "only"`.
     */
    scriptCallable: () =>
      [...tools.values()].flatMap((tool) => {
        const exposure = tool.exposure ?? "direct";
        const callable =
          exposure === "codemode" ||
          exposure === "deferred" ||
          (exposure === "direct" && active.includes(tool.name));
        return callable ? [tool.name] : [];
      }),
    /** What `pi.getAllTools()` reports to a permission extension: each tool's MCP hints. */
    annotations: (name: string) => tools.get(name)?.annotations,
    /** The "Available tools" lines Pi writes into its system prompt: active tools with a snippet. */
    promptToolLines: () =>
      active.flatMap((name) => {
        const snippet = tools.get(name)?.promptSnippet?.replace(/\s+/g, " ").trim();
        return snippet ? [`- ${name}: ${snippet}`] : [];
      }),
    /** The handlers registered for an event, for peers that call them with their own context. */
    handlers: (event: string): readonly unknown[] => handlers.get(event) ?? [],
    emit,
    /** Loads the factory as Pi does at startup, then starts the session. */
    async start(factory: Factory): Promise<void> {
      try {
        await factory(api);
      } catch (error) {
        phase = "failed";
        throw error;
      }
      phase = "active";
      await emit("session_start", { type: "session_start", reason: "startup" });
    },
    async shutdown(): Promise<void> {
      await emit("session_shutdown", { type: "session_shutdown" });
    },
  };
}
