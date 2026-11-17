/**
 * The environment gate's RPC (ADR 0176 §10), on OpenCode's public Promise plugin interface. ace
 * says, per session, whether that session's shell environment is set; the plugin holds each
 * tool until ace has said so. No credentials and no variables cross it: only a session id and
 * the outcome.
 */
export const agentEnvRpc = {
  id: "ace.agent.environment",
  methods: {
    settle: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", minLength: 1, maxLength: 256 },
          ok: { type: "boolean" },
          message: { type: "string", maxLength: 1024 },
        },
        required: ["sessionID", "ok"],
        additionalProperties: false,
      },
      output: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  events: {},
} as const;

/**
 * How long a tool waits for ace to settle its session's environment before it is refused.
 * Setting it takes one local request, so this only runs out when ace can't reach the server.
 */
export const environmentGateMs = 30_000;

/** What a tool refused by the gate says, to the agent and in the transcript. */
export function gateRefusal(reason: string): string {
  return `ace couldn't give this session its thread's shell environment (ACE_THREAD_ID, ACE_NO_INPUT, ACE_HOME), so the tool did not run: ${reason}`;
}
