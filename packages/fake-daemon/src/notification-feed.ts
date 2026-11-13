import type {
  ClientMessage,
  Notification,
  NotificationAddress,
  ServerMessage,
} from "@ace/protocol";

/**
 * The fixture's catch-up feed: every pushed alert, with a growing cursor. Tests and the iOS spike
 * withdraw one with `retract` to stand in for the daemon's canonical-state recheck. A device that
 * sent `notification.unregister` gets no entries for alerts recorded before it registers again.
 */
export class FakeNotificationFeed {
  private entries: { cursor: number; notification: Notification; muted: Set<string> }[] = [];
  private retracted = new Set<string>();
  private unregistered = new Set<string>();
  private head = 0;
  private addresses = new Map<string, NotificationAddress>();
  private acks: { device: string; id: string }[] = [];
  private pushRefused: "invalid_message" | "unsupported" | false = false;
  private rejections = 0;
  /** The address `device` registered last; none once it unregisters. */
  address(device: string): NotificationAddress | undefined {
    return this.addresses.get(device);
  }
  /** The alert ids `device` acknowledged (`notification.ack`), oldest first. */
  acknowledged(device: string): string[] {
    return this.acks.filter((ack) => ack.device === device).map((ack) => ack.id);
  }
  /**
   * Answer push addresses as a daemon older than ADR 0106 does: its schema lacks the `push`
   * channel, so the frame doesn't parse and it refuses it with `invalid_message`, or with
   * `unsupported` from a daemon built between 2026-11-01 and 2026-11-05.
   */
  refusePush(code: "invalid_message" | "unsupported" | false = "invalid_message"): void {
    this.pushRefused = code;
  }
  /** The next `count` registrations fail as a daemon's store can (`notification_rejected`). */
  rejectRegistrations(count = 1): void {
    this.rejections = count;
  }
  record(notification: Notification): void {
    if (this.entries.some((entry) => entry.notification.id === notification.id)) return;
    this.retracted.delete(notification.id);
    this.entries.push({ cursor: ++this.head, notification, muted: new Set(this.unregistered) });
    if (this.entries.length > 100) this.entries.shift();
  }
  retract(id: string): void {
    if (this.entries.some((entry) => entry.notification.id === id)) this.retracted.add(id);
  }
  /** Answers registration, acks and `notification.feed`; presence and snooze are accepted without effect. */
  handle(message: ClientMessage, emit: (message: ServerMessage) => void, device: string): boolean {
    if (message.type === "presence.update" || message.type === "notification.snooze") return true;
    if (message.type === "notification.ack") {
      this.acks.push({ device, id: message.id });
      return true;
    }
    if (message.type === "notification.register") {
      if (this.pushRefused && message.device.channel === "push") {
        emit({
          type: "error",
          code: this.pushRefused,
          message: "Message does not match the protocol",
          ...(message.requestId ? { requestId: message.requestId } : {}),
        });
        return true;
      }
      if (this.rejections > 0) {
        this.rejections--;
        emit({
          type: "error",
          code: "notification_rejected",
          message: "Notification update rejected",
          ...(message.requestId ? { requestId: message.requestId } : {}),
        });
        return true;
      }
      this.unregistered.delete(device);
      this.addresses.set(device, message.device);
      if (message.requestId)
        emit({ type: "notification.register.result", requestId: message.requestId });
      return true;
    }
    if (message.type === "notification.unregister") {
      this.unregistered.add(device);
      this.addresses.delete(device);
      if (message.requestId)
        emit({ type: "notification.unregister.result", requestId: message.requestId });
      return true;
    }
    if (message.type !== "notification.feed") return false;
    const after = message.afterCursor > this.head ? 0 : message.afterCursor;
    emit({
      type: "notification.feed.result",
      requestId: message.requestId,
      cursor: this.head,
      entries: this.entries
        .filter(
          (entry) =>
            entry.cursor > after &&
            !entry.muted.has(device) &&
            !this.retracted.has(entry.notification.id),
        )
        .map(({ cursor, notification }) => ({ cursor, notification })),
      retracted: [...this.retracted],
    });
    return true;
  }
}
