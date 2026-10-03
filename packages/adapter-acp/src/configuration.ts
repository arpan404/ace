import type { SessionContext } from "@ace/engine-api";
import type { Capabilities, AcpSessionSupport } from "@ace/protocol";
import { sessionSelectors, selectorRequest, type SelectorState } from "@ace/agent-registry";
import type { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import { negotiate, sessionSupport, type Negotiated } from "./negotiation.ts";
import { redactLease } from "./frame-redaction.ts";
import { object } from "./data.ts";
import type { AcpQuirks } from "./quirks/types.ts";
import type { LaunchOptions } from "./runtime.ts";
/** Session-derived selectors and effective capabilities; no provider-name model dispatch. */
export class AcpConfiguration {
  capabilities: Capabilities | undefined;
  support: AcpSessionSupport | undefined;
  selectors: SelectorState = { raw: {} };
  negotiated: Negotiated | undefined;
  readonly #ctx: SessionContext;
  readonly #quirks: AcpQuirks;
  readonly #launch: LaunchOptions;
  readonly #rpc: JsonRpcPeer;
  constructor(ctx: SessionContext, quirks: AcpQuirks, launch: LaunchOptions, rpc: JsonRpcPeer) {
    this.#ctx = ctx;
    this.#quirks = quirks;
    this.#launch = launch;
    this.#rpc = rpc;
  }
  initialize(raw: unknown): Negotiated {
    this.negotiated = negotiate(raw, this.#quirks, this.#launch.version, this.#launch.profile);
    this.capabilities = this.negotiated.capabilities;
    return this.negotiated;
  }
  setup(raw: unknown, mcp: AcpSessionSupport["mcp"]): void {
    this.selectors = sessionSelectors(
      this.#redact(raw),
      this.#launch.profile,
      this.#quirks.provider !== "acp",
    );
    this.publish(mcp);
    this.#ctx.onSessionMetadata?.(this.selectors.raw);
  }
  update(raw: unknown): void {
    const replacement = { ...object(this.selectors.raw), ...object(this.#redact(raw)) };
    try {
      this.selectors = sessionSelectors(
        replacement,
        this.#launch.profile,
        this.#quirks.provider !== "acp",
      );
    } catch {
      this.selectors = { raw: replacement };
    }
    this.publish(this.support?.mcp ?? "unavailable");
    this.#ctx.onSessionMetadata?.(this.selectors.raw);
  }
  publish(mcp: AcpSessionSupport["mcp"]): void {
    if (!this.negotiated) return;
    this.capabilities = {
      ...this.negotiated.capabilities,
      planMode: this.selectors.mode?.values.includes("plan") ?? false,
    };
    this.support = sessionSupport(
      { ...this.negotiated, raw: this.#redact(this.negotiated.raw) },
      this.selectors,
      mcp,
      this.#launch.profile
        ? "source_profile"
        : this.#quirks.provider === "acp"
          ? "generic"
          : "legacy",
    );
    this.#ctx.onCapabilities?.(this.capabilities, this.support);
  }
  async select(kind: "model" | "mode", value: string, sessionId: string): Promise<void> {
    const request = selectorRequest(this.selectors, kind, value, sessionId);
    const result = await this.#rpc.request(request.method, request.params, {
      signal: this.#ctx.signal,
    });
    if (Array.isArray(object(result)["configOptions"])) this.update(result);
  }
  #redact(raw: unknown): unknown {
    return redactLease(raw, this.#ctx.mcp?.secrets ?? []);
  }
}
