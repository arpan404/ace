import type { SDKAgent, Run } from "@cursor/sdk";
export type SdkModule = typeof import("@cursor/sdk");
export type SdkRunBoundary = Pick<Run, "id" | "stream" | "wait" | "cancel">;
export type SdkAgentBoundary = Pick<SDKAgent, "agentId" | typeof Symbol.asyncDispose> & {
  send(...args: Parameters<SDKAgent["send"]>): Promise<SdkRunBoundary>;
};
/** Only official SDK operations used by the host; offline tests substitute this edge. */
export type RuntimeSdkBoundary = Pick<
  SdkModule,
  "JsonlLocalAgentStore" | "AuthenticationError" | "RateLimitError" | "NetworkError"
> & {
  /** Host-only SDK prewarm probe, without a provider turn. */
  sandboxSupport?(options: import("@cursor/sdk").AgentOptions): Promise<boolean>;
  Cursor: { auth: Pick<SdkModule["Cursor"]["auth"], "status"> };
  Agent: Pick<SdkModule["Agent"], "cancelRun"> & {
    create(...args: Parameters<SdkModule["Agent"]["create"]>): Promise<SdkAgentBoundary>;
    resume(...args: Parameters<SdkModule["Agent"]["resume"]>): Promise<SdkAgentBoundary>;
  };
};
