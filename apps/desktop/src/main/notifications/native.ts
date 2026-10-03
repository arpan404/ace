import { Notification } from "electron";
import type { DeepLink } from "../../shared/contract.ts";
import type { actionCommand } from "./actions.ts";
import type { NotificationAction, Shown } from "./router.ts";

export interface NotifierPorts {
  open(link: DeepLink): void;
  send(command: NonNullable<ReturnType<typeof actionCommand>>): Promise<unknown>;
  log(message: string): void;
}

/**
 * Shows routed notifications through the OS. One live notification per tag (one per thread),
 * so a newer alert replaces the older one instead of stacking. macOS and Windows get the
 * Approve / Deny buttons and an inline reply field; Linux shows plain notifications.
 */
export class NativeNotifier {
  private live = new Map<string, Notification>();
  private ports: NotifierPorts;
  constructor(ports: NotifierPorts) {
    this.ports = ports;
  }

  show(shown: Shown): void {
    if (!Notification.isSupported()) return;
    this.live.get(shown.tag)?.close();
    const notification = new Notification({
      id: shown.tag,
      groupId: shown.groupId,
      title: shown.title,
      body: shown.body,
      silent: false,
      hasReply: shown.reply,
      replyPlaceholder: "Reply…",
      actions: shown.actions.map((entry) => ({ type: "button", text: entry.label })),
    });
    notification.on("click", () => this.ports.open(shown.link));
    notification.on("action", (event) => {
      const chosen = shown.actions[event.actionIndex];
      if (chosen) this.act(shown, chosen.action);
    });
    notification.on("reply", (event) => this.act(shown, "reply", event.reply));
    notification.on("close", () => {
      if (this.live.get(shown.tag) === notification) this.live.delete(shown.tag);
    });
    this.live.set(shown.tag, notification);
    notification.show();
  }

  /** Remove a thread's notification once it no longer applies (answered elsewhere). */
  clear(tag: string): void {
    this.live.get(tag)?.close();
    this.live.delete(tag);
  }

  private act(shown: Shown, action: NotificationAction, reply?: string): void {
    void this.command(shown, action, reply)
      .then((command) => {
        if (command) return this.ports.send(command);
        this.ports.open(shown.link);
        return undefined;
      })
      .catch((error: unknown) => {
        this.ports.log(`Notification action failed: ${String(error)}`);
        this.ports.open(shown.link);
      });
  }

  /** The command schemas load with the first action, not with the app. */
  private async command(shown: Shown, action: NotificationAction, reply?: string) {
    if (!shown.alert) return undefined;
    const { actionCommand } = await import("./actions.ts");
    return actionCommand(shown.alert, action, reply);
  }
}
