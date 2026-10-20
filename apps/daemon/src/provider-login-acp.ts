import { z } from "zod";
import { basename } from "node:path";
import { probeOutput, spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import {
  loginObservation,
  loginUrl,
  ProviderLoginFailure,
  type ProviderLoginDriver,
} from "@ace/accounts";
import { signInPages, type SignInPages } from "./sign-in-pages.ts";
import type { OpenTerminalOptions } from "@ace/terminal";
import type { ProviderKind, ProviderLoginInput } from "@ace/protocol";

const Method = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  type: z.string().optional(),
  // Read only to tell a key or gateway setup from a sign-in; never fatal when odd.
  description: z.string().max(4096).optional().catch(undefined),
  _meta: z.record(z.string(), z.unknown()).optional().catch(undefined),
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

const keyed = /api[ _-]?key|token|credential|password|gateway/i;
const setup = /api[ _-]?key|gateway/i;
/** A browser sign-in gets as long as ace's sign-in session lasts. */
const authenticateMs = 10 * 60_000;
const ownLogoutMs = 30_000;

/**
 * A method ace can finish: the agent's own sign-in or its interactive terminal. Methods that need
 * a key, a gateway or variables set beforehand are the agent's own setup, not a sign-in.
 */
function signInMethod(method: z.infer<typeof Method>, terminal: boolean): boolean {
  if (method.type && method.type !== "agent" && !(method.type === "terminal" && terminal))
    return false;
  const meta = method["_meta"];
  if (meta && ("api-key" in meta || "gateway" in meta)) return false;
  // A description only rules a method out when it asks for a key or gateway: Cursor's own
  // sign-in says it uses "existing Cursor login credentials".
  return !keyed.test(`${method.id} ${method.name}`) && !setup.test(method.description ?? "");
}

/** Only the installed agent performs authentication. No token exchange or credential store. */
export function acpLoginDriver(options: {
  provider: Extract<ProviderKind, "acp" | "antigravity">;
  action: "login" | "logout";
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawn?: typeof spawnSupervised;
  /** The sign-in process's page opener; tests stand one in so no real browser opens. */
  pages?: (env: NodeJS.ProcessEnv) => Promise<SignInPages>;
  /**
   * The installed command's own sign-out arguments, for an agent whose ACP has none (Cursor's
   * `cursor-agent logout`). Its output is never relayed.
   */
  ownLogout?: readonly string[];
  openTerminal?: (launch: OpenTerminalOptions) => {
    id: string;
    exited: Promise<boolean>;
    stop(): Promise<void>;
  };
}): ProviderLoginDriver & {
  /** The agent method a completed browser sign-in used, for selecting it again later. */
  signedInWith(): string | undefined;
} {
  let process: SupervisedProcess | undefined;
  let signedInWith: string | undefined;
  let rpc: JsonRpcPeer | undefined;
  let terminal: ReturnType<NonNullable<typeof options.openTerminal>> | undefined;
  let choose: ((choice: string) => boolean) | undefined;
  let pages: SignInPages | undefined;
  return {
    signedInWith: () => signedInWith,
    input(input: ProviderLoginInput) {
      return "choice" in input && !!choose?.(input.choice);
    },
    async drain() {
      rpc?.close();
      await process?.stop({ graceMs: 0 });
      await terminal?.stop();
      await pages?.close();
    },
    async run(signal, emit) {
      signal.throwIfAborted();
      if (options.action === "logout" && options.ownLogout) {
        let code: number | null = null;
        try {
          ({ code } = await probeOutput(options.command, options.ownLogout, {
            env: options.env,
            signal,
            timeoutMs: ownLogoutMs,
          }));
        } catch {
          signal.throwIfAborted();
        }
        if (code !== 0)
          throw new ProviderLoginFailure(
            `The agent didn't sign out. Run \`${basename(options.command)} ${options.ownLogout.join(" ")}\` in a terminal, then check again.`,
          );
        return { success: true };
      }
      const opened = await (options.pages ?? signInPages)(options.env);
      pages = opened;
      // Relay a page the client can open (the desktop app opens it, another device links it);
      // open any other one here, as the agent meant to.
      const relayed = new Set<string>();
      const relay = async () => {
        for (const page of await opened.take()) {
          if (relayed.has(page)) continue;
          relayed.add(page);
          const url = loginUrl(options.provider, page);
          if (url) emit({ state: "awaiting_browser", url });
          else opened.open(page);
        }
      };
      const watching = setInterval(() => {
        relay().catch(() => {});
      }, 200);
      const connect = () => {
        process = (options.spawn ?? spawnSupervised)({
          command: options.command,
          args: [...options.args],
          env: opened.env,
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
      let connected: ReturnType<typeof connect>;
      try {
        connected = connect();
      } catch (error) {
        clearInterval(watching);
        pages = undefined;
        await opened.close();
        throw error;
      }
      const { child, peer } = connected;
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
        const methods = init.authMethods.filter((method) =>
          signInMethod(method, !!options.openTerminal),
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
            env: { ...opened.env, ...selected.env },
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
        // Bounded like the sign-in session itself: an agent that never answers can't hold it.
        z.object({}).parse(
          await peer.request("authenticate", { methodId }, { signal, timeoutMs: authenticateMs }),
        );
        signedInWith = methodId;
        return { success: true };
      } finally {
        choose = undefined;
        clearInterval(watching);
        signal.removeEventListener("abort", stop);
        peer.close();
        await child.stop({ graceMs: 0 });
        pages = undefined;
        await opened.close();
      }
    },
  };
}
