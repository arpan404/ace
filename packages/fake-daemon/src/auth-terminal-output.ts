import type { ProviderKind, ServerMessage, TerminalRequest } from "@ace/protocol";

export interface FakeAuthTerminal {
  session?: string;
  instanceId: string;
  action: "login" | "logout";
  owner: (message: ServerMessage) => void;
  scope?: "operate";
  provider?: ProviderKind;
  subscriptionId?: string;
  offset?: number;
  input?: string;
}

/** Native Pi's editor waits for input and exit; other fixture logins complete on subscribe. */
export function authTerminalOutput(
  flow: FakeAuthTerminal,
  op: TerminalRequest["operation"],
  complete: () => void,
) {
  const output = (data: string) => {
    if (!flow.subscriptionId) return;
    const offset = flow.offset ?? 0;
    flow.offset = offset + data.length;
    flow.owner({
      type: "terminal.output",
      subscriptionId: flow.subscriptionId,
      event: { type: "data", offset, endOffset: flow.offset, data, truncatedBefore: false },
    });
  };
  const exit = () => {
    complete();
    if (flow.subscriptionId)
      flow.owner({
        type: "terminal.output",
        subscriptionId: flow.subscriptionId,
        event: { type: "exit", status: { code: 0, signal: null }, nextOffset: flow.offset ?? 0 },
      });
  };
  if (op.op === "subscribe") {
    flow.subscriptionId = op.subscriptionId;
    output(
      flow.provider === "pi"
        ? "Pi ready. Type /login, then /exit when finished.\r\nPi > "
        : "Complete the provider's own sign-in flow.\r\n",
    );
    if (flow.provider !== "pi") exit();
  }
  if (op.op === "write" && flow.provider === "pi") {
    for (const character of op.data) {
      if (character === "\r" || character === "\n") {
        const line = flow.input ?? "";
        flow.input = "";
        output(`\r\nPi received: ${line}\r\n`);
        if (line === "/exit") {
          exit();
          return;
        }
        output("Pi > ");
      } else if (character === "\x7f") flow.input = (flow.input ?? "").slice(0, -1);
      else {
        flow.input = `${flow.input ?? ""}${character}`.slice(-8192);
        output(character);
      }
    }
  }
}
