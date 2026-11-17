import { agentEnvRpc, environmentGateMs, gateRefusal } from "../agent-env-contract.ts";

// The installed OpenCode host supplies these public Promise plugin interfaces.
// Keep this entry dependency-free; it runs in the OpenCode server, not the daemon.
type Settle = { sessionID: string; ok: boolean; message?: string };
type Context = {
  tool: {
    hook(
      name: "execute.before",
      run: (input: { tool: string; sessionID: string }) => Promise<void>,
    ): Promise<unknown>;
  };
  rpc: {
    register(
      definition: typeof agentEnvRpc,
      handlers: { settle(input: Settle, context: { signal: AbortSignal }): Promise<object> },
    ): Promise<unknown>;
  };
};

type Verdict = { ok: true } | { ok: false; message: string };
type Gate = {
  verdicts: Map<string, Verdict>;
  waiting: Map<string, Set<(verdict: Verdict) => void>>;
};

/**
 * One gate for the whole server process: OpenCode activates this plugin once per location and
 * may rebuild a location, but a session's environment lives as long as the server does, and
 * so does what ace said about it. A new server process starts with no verdicts, as it starts
 * with no environments.
 */
const shared = Symbol.for("ace.agent.environment.gate");
function gate(): Gate {
  const holder: Record<symbol, unknown> = globalThis;
  const existing = holder[shared];
  if (existing) return existing as Gate;
  const made: Gate = { verdicts: new Map(), waiting: new Map() };
  holder[shared] = made;
  return made;
}

/** The session's verdict, waiting for ace's up to `environmentGateMs`. */
function verdictFor(sessionID: string): Promise<Verdict> {
  const { verdicts, waiting } = gate();
  const known = verdicts.get(sessionID);
  if (known) return Promise.resolve(known);
  return new Promise<Verdict>((resolve) => {
    const waiters = waiting.get(sessionID) ?? new Set();
    waiting.set(sessionID, waiters);
    const settle = (verdict: Verdict) => {
      clearTimeout(timer);
      waiters.delete(settle);
      if (!waiters.size) waiting.delete(sessionID);
      resolve(verdict);
    };
    const timer = setTimeout(
      () => settle({ ok: false, message: "ace never confirmed it" }),
      environmentGateMs,
    );
    waiters.add(settle);
  });
}

export default {
  id: agentEnvRpc.id,
  async setup(context: Context): Promise<void> {
    // Every tool of every session waits until ace has set that session's environment, so no
    // command ever runs with the server's own. A failed or missing setup refuses the tool.
    await context.tool.hook("execute.before", async (input) => {
      const verdict = await verdictFor(input.sessionID);
      if (!verdict.ok) throw new Error(gateRefusal(verdict.message));
    });
    await context.rpc.register(agentEnvRpc, {
      async settle(input) {
        const verdict: Verdict = input.ok
          ? { ok: true }
          : { ok: false, message: input.message || "setup failed" };
        const { verdicts, waiting } = gate();
        verdicts.set(input.sessionID, verdict);
        // Each waiter removes only itself, which a Set allows while it is iterated.
        for (const waiter of waiting.get(input.sessionID) ?? []) waiter(verdict);
        return {};
      },
    });
  },
};
