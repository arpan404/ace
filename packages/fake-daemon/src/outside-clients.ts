import type {
  ClientMessage,
  OutsideAccessDecision,
  OutsideAccessRequest,
  OutsideGrantEntry,
  OutsideOutcome,
  OutsideScreenUse,
  ServerMessage,
} from "@ace/protocol";

type Push = (message: ServerMessage) => void;

/**
 * Outside MCP clients' grants as the daemon offers them to an administrator (ADR 0117), over
 * fixture state: list, revoke and change grants, watch pending sign-ins and screen use, answer a
 * sign-in, stop a client's screen work. Tests and scenarios stage what the person finds with
 * `ask`, `useScreen` and the public fields; `decisions` records what the person chose.
 */
export class FakeOutsideClients {
  grants: OutsideGrantEntry[] = [];
  access: OutsideAccessRequest[] = [];
  screen: OutsideScreenUse[] = [];
  readonly decisions: { requestId: string; choice: OutsideAccessDecision }[] = [];
  private watchers = new Set<Push>();
  private readonly clock: () => number;
  private readonly admin: (deviceId: string) => boolean;
  constructor(clock: () => number, admin: (deviceId: string) => boolean) {
    this.clock = clock;
    this.admin = admin;
  }

  /** A client asks to sign in; watching devices see it at once. */
  ask(request: OutsideAccessRequest): void {
    this.access = [
      ...this.access.filter((entry) => entry.requestId !== request.requestId),
      request,
    ];
    this.changed();
  }
  /** Clients using the screen now. */
  useScreen(uses: OutsideScreenUse[]): void {
    this.screen = uses;
    this.changed();
  }
  release(push: Push): void {
    this.watchers.delete(push);
  }

  /** True when it answered `message`. */
  handle(message: ClientMessage, push: Push, deviceId: string): boolean {
    if (message.type !== "outside.request") return false;
    const { requestId, operation } = message;
    const fail = (code: string) => push({ type: "error", code, message: code, requestId });
    if (!this.admin(deviceId)) {
      fail("forbidden");
      return true;
    }
    const answer = (result: OutsideOutcome) => push({ type: "outside.result", requestId, result });
    const grant = (id: string) =>
      this.grants.find((entry) => entry.id === id && entry.revokedAt === null);
    switch (operation.op) {
      case "grants":
        answer({ kind: "grants", grants: this.grants });
        return true;
      case "revoke": {
        const found = grant(operation.grantId);
        if (!found) return (fail("not_found"), true);
        this.grants = this.grants.map((entry) =>
          entry === found ? { ...entry, revokedAt: this.clock() } : entry,
        );
        this.useScreen(this.screen.filter((use) => use.grantId !== found.id));
        answer({ kind: "revoked" });
        return true;
      }
      case "update": {
        const found = grant(operation.grantId);
        if (!found) return (fail("not_found"), true);
        const next: OutsideGrantEntry = {
          ...found,
          ...(operation.scopes ? { scopes: operation.scopes } : {}),
          ...(operation.projects ? { projects: operation.projects } : {}),
          ...(operation.expiresAt !== undefined ? { expiresAt: operation.expiresAt } : {}),
        };
        this.grants = this.grants.map((entry) => (entry === found ? next : entry));
        const { started: _started, messaged: _messaged, ...plain } = next;
        answer({ kind: "updated", grant: plain });
        return true;
      }
      case "watch":
        this.watchers.add(push);
        answer({ kind: "watching" });
        this.send(push);
        return true;
      case "endpoints":
        answer({ kind: "endpoints", endpoints: [] });
        return true;
      case "stopScreen": {
        const found = grant(operation.grantId);
        if (!found) return (fail("not_found"), true);
        this.grants = this.grants.map((entry) =>
          entry === found
            ? { ...entry, scopes: entry.scopes.filter((scope) => scope !== "computer") }
            : entry,
        );
        this.useScreen(this.screen.filter((use) => use.grantId !== found.id));
        answer({ kind: "screenStopped" });
        return true;
      }
      case "decide": {
        const pending = this.access.find(
          (entry) =>
            entry.requestId === operation.accessRequestId && entry.expiresAt > this.clock(),
        );
        if (!pending) return (fail("not_found"), true);
        this.decisions.push({ requestId: pending.requestId, choice: operation.choice });
        this.access = this.access.filter((entry) => entry !== pending);
        this.changed();
        answer({ kind: "decided" });
        return true;
      }
    }
  }
  private changed(): void {
    for (const push of this.watchers) this.send(push);
  }
  private send(push: Push): void {
    push({ type: "outside.state", access: this.access, screen: this.screen });
  }
}
