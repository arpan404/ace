import type {
  ClientMessage,
  LockedUseStatus,
  ServerMessage,
  UserBrowserStatus,
} from "@ace/protocol";

type Push = (message: ServerMessage) => void;

/**
 * Locked computer use and Use my Chrome as the daemon offers them, over fixture state: locked
 * use's subscription and its install, remove and repair (an install waits for approval until
 * `approve()`), and Use my Chrome's status, install, stop and revoke. Nothing touches the Mac.
 * Tests and scenarios set the public fields to stage what the person finds.
 */
export class FakeComputerAccess {
  locked: LockedUseStatus = { state: "off" };
  /** The next locked-use change is refused with this code. */
  refuse: "forbidden" | "busy" | "unavailable" | undefined;
  chrome: UserBrowserStatus = {
    supported: true,
    extensionId: "fakeextensionidaceaceaceaceaceac",
    installed: [],
    connections: [],
  };
  private revision = 0;
  private subscribers = new Map<string, Push>();

  /** True when it answered `message`. */
  handle(message: ClientMessage, push: Push): boolean {
    switch (message.type) {
      case "lockedUse.subscribe":
        this.subscribers.set(message.subscriptionId, push);
        push({
          type: "lockedUse.status",
          requestId: message.requestId,
          subscriptionId: message.subscriptionId,
          revision: this.revision,
          status: this.locked,
        });
        return true;
      case "lockedUse.unsubscribe":
        this.subscribers.delete(message.subscriptionId);
        push({ type: "lockedUse.result", requestId: message.requestId, ok: true });
        return true;
      case "lockedUse.install":
      case "lockedUse.remove":
      case "lockedUse.repair": {
        if (this.refuse) {
          const code = this.refuse;
          this.refuse = undefined;
          push({
            type: "lockedUse.result",
            requestId: message.requestId,
            ok: false,
            code,
            reason: code,
            revision: this.revision,
            status: this.locked,
          });
          return true;
        }
        this.set(
          message.type === "lockedUse.remove"
            ? { state: "off" }
            : message.type === "lockedUse.repair"
              ? { state: "on" }
              : { state: "needsApproval" },
        );
        push({
          type: "lockedUse.result",
          requestId: message.requestId,
          ok: true,
          revision: this.revision,
          status: this.locked,
        });
        return true;
      }
      case "user_browser.settings": {
        if (message.operation === "install")
          this.chrome = {
            ...this.chrome,
            installed: [
              { browser: "Chrome", manifestPath: "/fake/NativeMessagingHosts/dev.ace.json" },
            ],
            extensionPath: "/Users/ada/.ace/chrome-extension",
          };
        else if (message.operation === "revoke")
          this.chrome = { ...this.chrome, installed: [], connections: [] };
        else if (message.operation === "stop")
          this.chrome = {
            ...this.chrome,
            connections: this.chrome.connections.map((connection) => ({
              ...connection,
              tabs: connection.tabs.map((tab) => ({ ...tab, attached: false })),
            })),
          };
        push({
          type: "user_browser.settings.result",
          requestId: message.requestId,
          result: { kind: "status", status: this.chrome },
        });
        return true;
      }
      default:
        return false;
    }
  }
  /** The person approved the component in System Settings. */
  approve(): void {
    if (this.locked.state === "needsApproval") this.set({ state: "on" });
  }
  /** What is installed drifted: the Mac now needs a repair. */
  drift(reason: string): void {
    this.set({ state: "driftRepairNeeded", reason });
  }
  private set(status: LockedUseStatus): void {
    this.locked = status;
    this.revision++;
    for (const [subscriptionId, push] of this.subscribers)
      push({ type: "lockedUse.changed", subscriptionId, revision: this.revision, status });
  }
}
