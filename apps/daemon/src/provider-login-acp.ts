import { z } from "zod";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import { loginObservation, type ProviderLoginDriver } from "@ace/accounts";
import type { OpenTerminalOptions } from "@ace/terminal";
import type { ProviderKind, ProviderLoginInput } from "@ace/protocol";

const Method = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  type: z.string().optional(),
  args: z.array(z.string().max(4096)).max(64).default([]),
  env: z
    .record(z.string().max(256), z.string().max(32768))
    .refine((value) => Object.keys(value).length <= 512)
    .default({}),
});
const Initialization = z.object({
  protocolVersion: z.literal(1),
  agentInfo: z.object({ name: z.string() }).optional(),
  authMethods: z.array(Method).max(32).default([]),
  agentCapabilities: z
    .object({ auth: z.object({ logout: z.object({}).nullable().optional() }).optional() })
    .optional(),
});

/** Only the installed agent performs authentication. No token exchange or credential store. */
export function acpLoginDriver(options: {
  provider: Extract<ProviderKind, "acp" | "antigravity">;
  action: "login" | "logout";
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawn?: typeof spawnSupervised;
  openTerminal?: (launch: OpenTerminalOptions) => {
    id: string;
    exited: Promise<boolean>;
    stop(): Promise<void>;
  };
}): ProviderLoginDriver {
  let process: SupervisedProcess | undefined;
  let rpc: JsonRpcPeer | undefined;
  let terminal: ReturnType<NonNullable<typeof options.openTerminal>> | undefined;
  let choose: ((choice: string) => boolean) | undefined;
  return {
    input(input: ProviderLoginInput) {
      return "choice" in input && !!choose?.(input.choice);
    },
    async drain() {
      rpc?.close();
      await process?.stop({ graceMs: 0 });
      await terminal?.stop();
    },
    async run(signal, emit) {
      signal.throwIfAborted();
      const connect = () => {
        process = (options.spawn ?? spawnSupervised)({
          command: options.command,
          args: [...options.args],
          env: { ...options.env, BROWSER: "echo" },
          cwd: options.cwd,
          name: "agent-sign-in",
          maxLineBytes: 65536,
          maxOutputBytes: 1024 * 1024,
        });
        const child = process;
        rpc = new JsonRpcPeer(child, {
          maxMessageBytes: 65536,
          maxPendingRequests: 4,
          maxIncomingRequests: 4,
        });
        const peer = rpc;
        // Drop all unreviewed output. Only the common reviewed challenge parser sees stderr.
        child.stderr.on("line", (line: string) => {
          const observation = loginObservation(options.provider, line);
          if (observation?.url || observation?.userCode) emit(observation);
        });
        return { child, peer };
      };
      const { child, peer } = connect();
      const stop = () => {
        peer.close();
        void child.stop({ graceMs: 0 });
      };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      try {
        const init = Initialization.parse(
          await peer.request(
            "initialize",
            {
              protocolVersion: 1,
              clientInfo: { name: "ace", version: "1" },
              clientCapabilities: options.openTerminal ? { auth: { terminal: true } } : {},
            },
            { signal, timeoutMs: 10000 },
          ),
        );
        if (options.provider === "antigravity" && init.agentInfo?.name !== "antigravity-acp")
          throw new Error("Unexpected installed agent");
        if (options.action === "logout") {
          if (!init.agentCapabilities?.auth?.logout) return { success: false };
          z.object({}).parse(await peer.request("logout", {}, { signal }));
          return { success: true };
        }
        // Secrets stay in the installed agent, including its advertised interactive terminal.
        const methods = init.authMethods.filter(
          (method) =>
            (!method.type ||
              method.type === "agent" ||
              (method.type === "terminal" && !!options.openTerminal)) &&
            !/api[ _-]?key|token|credential|password/i.test(`${method.id} ${method.name}`),
        );
        if (!methods.length) {
          emit({
            state: "failed",
            message:
              "This agent doesn't offer browser sign-in. Use its own account setup, then check again.",
          });
          return { success: false };
        }
        let methodId = methods[0]?.id;
        if (methods.length > 1) {
          methodId = await new Promise<string>((resolve, reject) => {
            const abort = () => {
              choose = undefined;
              reject(new Error("Cancelled"));
            };
            signal.addEventListener("abort", abort, { once: true });
            choose = (choice) => {
              const method = methods[Number(/^method-(\d+)$/.exec(choice)?.[1])];
              if (!method) return false;
              signal.removeEventListener("abort", abort);
              choose = undefined;
              resolve(method.id);
              return true;
            };
            emit({
              state: "awaiting_input",
              prompt: "Choose how to sign in.",
              choices: methods.map((method, index) => ({
                id: `method-${index}`,
                label: method.name,
              })),
            });
            if (signal.aborted) abort();
          });
        }
        const selected = methods.find((method) => method.id === methodId);
        if (selected?.type === "terminal" && options.openTerminal) {
          peer.close();
          await child.stop({ graceMs: 0 });
          terminal = options.openTerminal({
            shell: options.command,
            args: [...options.args, ...selected.args],
            env: { ...options.env, ...selected.env },
            cwd: options.cwd,
            cols: 80,
            rows: 24,
            name: "Agent sign-in",
          });
          const cancel = () => {
            void terminal?.stop();
          };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
          emit({
            state: "awaiting_input",
            manual: {
              action: "open_terminal",
              command: "Agent sign-in",
              instruction: "Complete the agent's own sign-in in this terminal.",
              terminalId: terminal.id,
            },
          });
          try {
            const success = await terminal.exited;
            signal.throwIfAborted();
            if (success) {
              const fresh = connect();
              try {
                Initialization.parse(
                  await fresh.peer.request(
                    "initialize",
                    {
                      protocolVersion: 1,
                      clientInfo: { name: "ace", version: "1" },
                      clientCapabilities: {},
                    },
                    { signal, timeoutMs: 10000 },
                  ),
                );
              } finally {
                fresh.peer.close();
                await fresh.child.stop({ graceMs: 0 });
              }
            }
            return { success };
          } finally {
            signal.removeEventListener("abort", cancel);
            await terminal.stop();
          }
        }
        emit({
          state: "awaiting_browser",
          hint: "Complete the installed agent's own browser sign-in.",
        });
        z.object({}).parse(
          await peer.request("authenticate", { methodId }, { signal, timeoutMs: null }),
        );
        return { success: true };
      } finally {
        choose = undefined;
        signal.removeEventListener("abort", stop);
        peer.close();
        await child.stop({ graceMs: 0 });
      }
    },
  };
}
