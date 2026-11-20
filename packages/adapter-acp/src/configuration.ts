import { acpPermissionModes } from "@ace/provider-kit/permission-modes";
import { accessModeOffers } from "@ace/provider-kit/access-modes";
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
  /** The mode the session last reported, or ace last set; a change from it is announced. */
  #mode: string | undefined;
  /** Inside a selection: its caller decides what a moved mode means. */
  #quiet = false;
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
  /** The profile negotiation kept: the launch's, unless the agent is another version now. */
  get #profile() {
    return this.negotiated ? this.negotiated.profile : this.#launch.profile;
  }
  setup(raw: unknown, mcp: AcpSessionSupport["mcp"]): void {
    this.selectors = sessionSelectors(
      this.#redact(raw),
      this.#profile,
      this.#quirks.provider !== "acp",
    );
    this.publish(mcp);
    this.#mode = this.current("mode");
    this.#ctx.onSessionMetadata?.(this.selectors.raw);
  }
  update(raw: unknown): void {
    const replacement = { ...object(this.selectors.raw), ...object(this.#redact(raw)) };
    try {
      this.selectors = sessionSelectors(
        replacement,
        this.#profile,
        this.#quirks.provider !== "acp",
      );
    } catch {
      this.selectors = { raw: replacement };
    }
    this.publish(this.support?.mcp ?? "unavailable");
    this.#ctx.onSessionMetadata?.(this.selectors.raw);
    this.#modeSeen();
  }
  /** The agent's `current_mode_update`: it changed its own session mode. */
  modeChanged(modeId: string): void {
    this.update({
      modes: { ...object(object(this.selectors.raw)["modes"]), currentModeId: modeId },
    });
  }
  /** Tells the session's owner the mode the agent runs now, when it moved. */
  announceMode(): void {
    const now = this.current("mode");
    if (now !== undefined) this.#ctx.onPermissionMode?.(now);
  }
  #modeSeen(): void {
    const now = this.current("mode");
    if (now === undefined || now === this.#mode) return;
    this.#mode = now;
    if (!this.#quiet) this.#ctx.onPermissionMode?.(now);
  }
  publish(mcp: AcpSessionSupport["mcp"]): void {
    if (!this.negotiated) return;
    const permissionModes = acpPermissionModes(this.selectors.raw, {
      provider: this.#quirks.provider,
      profile: this.#profile?.id,
    });
    this.capabilities = {
      ...this.negotiated.capabilities,
      permissionModes,
      accessModes: accessModeOffers(
        { provider: this.#quirks.provider, profile: this.#profile?.id },
        (native) => permissionModes.some((mode) => mode.id === native),
      ),
      permissions: {
        modes: permissionModes.map((mode) => mode.id),
        permissionModes,
        nativeAutoReview: false,
        toolGate: true,
      },
      planMode: this.selectors.mode?.values.includes("plan") ?? false,
    };
    this.support = sessionSupport(
      { ...this.negotiated, raw: this.#redact(this.negotiated.raw) },
      this.selectors,
      mcp,
      this.#profile ? "source_profile" : this.#quirks.provider === "acp" ? "generic" : "legacy",
    );
    this.#ctx.onCapabilities?.(this.capabilities, this.support);
  }
  /** The value the session last reported for a selector, when it reports one. */
  current(kind: "model" | "mode" | "effort"): string | undefined {
    const selector = this.selectors[kind];
    if (!selector) return undefined;
    const raw = object(this.selectors.raw);
    if (selector.configId) {
      const options = Array.isArray(raw["configOptions"]) ? raw["configOptions"] : [];
      const entry = options.find((option) => object(option)["id"] === selector.configId);
      const value = object(entry)["currentValue"];
      return typeof value === "string" ? value : undefined;
    }
    const value =
      kind === "mode"
        ? object(raw["modes"])["currentModeId"]
        : kind === "model"
          ? object(raw["models"])["currentModelId"]
          : undefined;
    return typeof value === "string" ? value : undefined;
  }
  /**
   * Selects `value` and checks what the reply reports. A reply that reports another value
   * didn't apply it: SelectorRefused. A reply without options (`session/set_mode`) applied it.
   */
  async select(kind: "model" | "mode" | "effort", value: string, sessionId: string): Promise<void> {
    const request = selectorRequest(this.selectors, kind, value, sessionId);
    const result = await this.#rpc.request(request.method, request.params, {
      signal: this.#ctx.signal,
    });
    this.#quiet = true;
    try {
      if (kind === "mode") this.#mode = value;
      if (Array.isArray(object(result)["configOptions"])) this.update(result);
      else this.#assume(kind, value);
    } finally {
      this.#quiet = false;
    }
    const now = this.current(kind);
    if (now !== undefined && now !== value) {
      if (kind === "mode") this.announceMode();
      throw new SelectorRefused(kind, value, now);
    }
  }
  /** Records a selection the agent accepted without reporting options back. */
  #assume(kind: "model" | "mode" | "effort", value: string): void {
    const selector = this.selectors[kind];
    if (!selector) return;
    const raw = object(this.selectors.raw);
    if (selector.configId) {
      const options = Array.isArray(raw["configOptions"]) ? raw["configOptions"] : [];
      this.update({
        configOptions: options.map((option) =>
          object(option)["id"] === selector.configId
            ? { ...object(option), currentValue: value }
            : option,
        ),
      });
    } else if (kind === "mode")
      this.update({ modes: { ...object(raw["modes"]), currentModeId: value } });
    else if (kind === "model")
      this.update({ models: { ...object(raw["models"]), currentModelId: value } });
  }
  #redact(raw: unknown): unknown {
    return redactLease(raw, this.#ctx.mcp?.secrets ?? []);
  }
}

/** The agent answered a selection with another value: it runs that one, not the one asked for. */
export class SelectorRefused extends Error {
  readonly kind: "model" | "mode" | "effort";
  constructor(kind: "model" | "mode" | "effort", requested: string, running: string) {
    super(`ACP ${kind} ${requested} was not applied; the agent runs ${running}`);
    this.kind = kind;
  }
}
