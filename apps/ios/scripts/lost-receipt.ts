import { ClientMessage, ServerMessage } from "@ace/protocol";

/** One scoped, deterministic failure after admission; only the first receipt is lost. */
export class LostReceipt {
  private text: string | undefined;
  private commandId: string | undefined;
  private attempts = 0;
  private dropped = 0;
  private delivered = 0;

  arm(text: string): void {
    this.text = text;
    this.commandId = undefined;
    this.attempts = this.dropped = this.delivered = 0;
  }
  observe(text: string): void {
    if (!this.text || !text.includes('"type":"command"')) return;
    const parsed = ClientMessage.safeParse(decode(text));
    if (!parsed.success || parsed.data.type !== "command") return;
    const command = parsed.data.command;
    if (
      command.payload.type !== "thread.send" ||
      !command.payload.input.some((part) => part.type === "text" && part.text === this.text)
    )
      return;
    this.commandId ??= command.id;
    if (this.commandId === command.id) this.attempts++;
  }
  drop(text: string): boolean {
    if (!this.commandId || !text.includes('"type":"commandResult"')) return false;
    const parsed = ServerMessage.safeParse(decode(text));
    if (
      !parsed.success ||
      parsed.data.type !== "commandResult" ||
      parsed.data.commandId !== this.commandId ||
      !parsed.data.ok
    )
      return false;
    if (this.dropped === 0) {
      this.dropped++;
      return true;
    }
    this.delivered++;
    return false;
  }
  state(): { attempts: number; dropped: number; delivered: number } {
    return { attempts: this.attempts, dropped: this.dropped, delivered: this.delivered };
  }
}

function decode(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
