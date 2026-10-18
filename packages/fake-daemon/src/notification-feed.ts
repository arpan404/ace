import type { ClientMessage, Notification, ServerMessage } from "@ace/protocol";

/**
 * The fixture's catch-up feed: every pushed alert, with a growing cursor. Tests and the iOS spike
 * withdraw one with `retract` to stand in for the daemon's canonical-state recheck.
 */
export class FakeNotificationFeed {
  private entries: { cursor: number; notification: Notification }[] = [];
  private retracted = new Set<string>();
  private head = 0;
  record(notification: Notification): void {
    if (this.entries.some((entry) => entry.notification.id === notification.id)) return;
    this.retracted.delete(notification.id);
    this.entries.push({ cursor: ++this.head, notification });
    if (this.entries.length > 100) this.entries.shift();
  }
  retract(id: string): void {
    if (this.entries.some((entry) => entry.notification.id === id)) this.retracted.add(id);
  }
  /** Answers `notification.feed`; presence and snooze are accepted without effect. */
  handle(message: ClientMessage, emit: (message: ServerMessage) => void): boolean {
    if (message.type === "presence.update" || message.type === "notification.snooze") return true;
    if (message.type !== "notification.feed") return false;
    const after = message.afterCursor > this.head ? 0 : message.afterCursor;
    emit({
      type: "notification.feed.result",
      requestId: message.requestId,
      cursor: this.head,
      entries: this.entries.filter(
        (entry) => entry.cursor > after && !this.retracted.has(entry.notification.id),
      ),
      retracted: [...this.retracted],
    });
    return true;
  }
}
