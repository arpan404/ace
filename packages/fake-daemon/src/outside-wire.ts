import type {
  OutsideAccessDecision,
  OutsideAccessRequest,
  OutsideEndpoint,
  OutsideGrantEntry,
  OutsideRequest,
  OutsideScreenUse,
  ServerMessage,
} from "@ace/protocol";

/**
 * The fixture's outside MCP clients (`outside.request`, ADR 0117), shared by every connection:
 * grants, pending sign-in requests, screen use and the addresses clients can use, each seeded by
 * a scenario. Decisions are kept so a test can read what an admin device chose. Scope refusals
 * happen before it (`request-scopes.ts`).
 */
export class FakeOutside {
  grants: OutsideGrantEntry[] = [];
  endpoints: OutsideEndpoint[] = [
    { path: "local", url: "http://127.0.0.1:47811/mcp", on: true },
    { path: "tailscale", url: null, on: false },
    { path: "relay", url: null, on: false },
    { path: "custom", url: null, on: false },
  ];
  /** Every `decide` an admin device sent, oldest first. */
  readonly decisions: { requestId: string; choice: OutsideAccessDecision }[] = [];
  /** Pending sign-ins; a scenario may clear them to stage a fresh start. */
  access: OutsideAccessRequest[] = [];
  private screen: OutsideScreenUse[] = [];
  private readonly watchers = new Set<(message: ServerMessage) => void>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }

  /** A client asks to sign in, as its `/authorize` page would. */
  ask(request: OutsideAccessRequest): void {
    this.access = [...this.access.filter((each) => each.requestId !== request.requestId), request];
    this.push();
  }
  /**
   * Another device answered request `requestId`: it leaves the pending list, and an approval adds
   * `grant`, as the daemon does.
   */
  settle(requestId: string, grant?: OutsideGrantEntry): void {
    if (grant) this.grants = [...this.grants, grant];
    this.access = this.access.filter((each) => each.requestId !== requestId);
    this.push();
  }
  /** Outside clients using the screen now. */
  useScreen(uses: OutsideScreenUse[]): void {
    this.screen = uses;
    this.push();
  }

  session(emit: (message: ServerMessage) => void) {
    return {
      handle: (request: OutsideRequest) => {
        const reply = this.run(request, emit);
        if (typeof reply === "string")
          emit({
            type: "error",
            code: reply,
            message: "No such grant or request, or it already ended.",
            requestId: request.requestId,
          });
        else emit({ type: "outside.result", requestId: request.requestId, result: reply });
        if (request.operation.op === "watch") emit(this.state());
      },
      close: () => {
        this.watchers.delete(emit);
      },
    };
  }

  private run(request: OutsideRequest, emit: (message: ServerMessage) => void) {
    const operation = request.operation;
    switch (operation.op) {
      case "grants":
        return { kind: "grants" as const, grants: this.grants };
      case "endpoints":
        return { kind: "endpoints" as const, endpoints: this.endpoints };
      case "watch":
        this.watchers.add(emit);
        return { kind: "watching" as const };
      case "revoke": {
        const grant = this.live(operation.grantId);
        if (!grant) return "not_found";
        grant.revokedAt = this.now();
        this.useScreen(this.screen.filter((use) => use.grantId !== grant.id));
        return { kind: "revoked" as const };
      }
      case "update": {
        const grant = this.live(operation.grantId);
        if (!grant) return "not_found";
        if (operation.scopes) grant.scopes = operation.scopes;
        if (operation.projects) grant.projects = operation.projects;
        if (operation.expiresAt !== undefined) grant.expiresAt = operation.expiresAt;
        const { started: _started, messaged: _messaged, ...plain } = grant;
        return { kind: "updated" as const, grant: plain };
      }
      case "stopScreen": {
        // As the daemon does: the screen work ends and `computer` leaves the grant.
        const grant = this.live(operation.grantId);
        if (!grant) return "not_found";
        grant.scopes = grant.scopes.filter((scope) => scope !== "computer");
        this.useScreen(this.screen.filter((use) => use.grantId !== grant.id));
        return { kind: "screenStopped" as const };
      }
      case "decide": {
        const pending = this.access.find(
          (each) => each.requestId === operation.accessRequestId && each.expiresAt > this.now(),
        );
        if (!pending) return "not_found";
        this.decisions.push({ requestId: operation.accessRequestId, choice: operation.choice });
        this.access = this.access.filter((each) => each.requestId !== operation.accessRequestId);
        this.push();
        return { kind: "decided" as const };
      }
    }
  }

  private live(id: string): OutsideGrantEntry | undefined {
    return this.grants.find((each) => each.id === id && each.revokedAt === null);
  }

  private state(): ServerMessage {
    return { type: "outside.state", access: this.access, screen: this.screen };
  }

  private push(): void {
    for (const send of this.watchers) send(this.state());
  }
}
