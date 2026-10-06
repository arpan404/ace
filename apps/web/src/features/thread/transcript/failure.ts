import type { AgentStatus } from "@ace/protocol";

/** Why an agent's turn failed, as its status reports it. */
export type Failure = Extract<AgentStatus, { state: "failed" }>["error"];
