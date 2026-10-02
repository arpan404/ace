import { createHash } from "node:crypto";
import { McpScope, type McpCapability } from "@ace/protocol";

export interface Principal {
  readonly scope: Readonly<
    Omit<McpScope, "capabilities"> & { capabilities: readonly McpCapability[] }
  >;
  readonly signal: AbortSignal;
}
export interface SessionLease {
  readonly bearer: string;
  readonly principal: Principal;
  end(): void;
}

/** In-memory authority; only the returned lease contains bearer material. */
export class CredentialRegistry {
  private entries = new Map<string, { principal: Principal; end(): void }>();
  private secret: () => string;
  private limit: number;
  private closed = false;
  constructor(secret: () => string, limit = 1024) {
    this.secret = secret;
    this.limit = limit;
  }
  issue(input: McpScope, lifetime: AbortSignal): SessionLease {
    if (this.closed) throw new Error("Credential registry closed");
    if (lifetime.aborted) throw new Error("Session ended");
    if (this.entries.size >= this.limit) throw new Error("Credential capacity reached");
    const parsed = McpScope.parse(input);
    const scope = Object.freeze({
      ...parsed,
      capabilities: Object.freeze([...new Set(parsed.capabilities)]),
    });
    const bearer = this.secret();
    if (!/^[a-f0-9]{64}$/.test(bearer))
      throw new Error("Credential generator must supply 256-bit hex");
    const key = digest(bearer);
    if (this.entries.has(key)) throw new Error("Credential collision");
    const controller = new AbortController();
    const principal = Object.freeze({ scope, signal: controller.signal });
    const end = () => {
      if (controller.signal.aborted) return;
      this.entries.delete(key);
      lifetime.removeEventListener("abort", end);
      controller.abort();
    };
    this.entries.set(key, { principal, end });
    lifetime.addEventListener("abort", end, { once: true });
    return Object.freeze({ bearer, principal, end });
  }
  authenticate(bearer: string): Principal | undefined {
    if (!/^[a-f0-9]{64}$/.test(bearer)) return undefined;
    return this.entries.get(digest(bearer))?.principal;
  }
  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) entry.end();
  }
}
function digest(bearer: string): string {
  return createHash("sha256").update(bearer).digest("hex");
}
