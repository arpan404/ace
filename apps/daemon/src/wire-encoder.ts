import type { ServerMessage, DeliveryEvent } from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";

/** One encoder per server. Weak keys cannot retain disconnected threads or past batches. */
export class WireEncoder {
  private events = new WeakMap<DeliveryEvent, string>();
  encode(message: ServerMessage | PluginServerMessage): string {
    if (message.type !== "events") return JSON.stringify(message);
    const encoded = message.events.map((event) => {
      let value = this.events.get(event);
      if (value === undefined) {
        value = JSON.stringify(event);
        this.events.set(event, value);
      }
      return value;
    });
    return `{"type":"events","subscriptionId":${JSON.stringify(message.subscriptionId)},"afterSeq":${message.afterSeq},"throughSeq":${message.throughSeq},"events":[${encoded.join(",")}]}`;
  }
}
