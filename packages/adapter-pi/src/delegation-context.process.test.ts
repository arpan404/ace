import { privateMcpConfig } from "@ace/mcp-server";
import { expect, test, onTestFinished } from "vitest";
import { registerAcePiExtension, type PiExtensionApi } from "./index.ts";

// Pi's extension API is the provider boundary; no provider CLI or home is used.
test("ace context wakes Pi with a custom message and rejects user impersonation", async () => {
  const commands = new Map<string, Parameters<PiExtensionApi["registerCommand"]>[1]>();
  const messages: { customType: string; content: string; display: boolean; details: unknown }[] =
    [];
  const pi: PiExtensionApi = {
    appendEntry() {},
    registerTool() {},
    on() {},
    registerCommand(name, command) {
      commands.set(name, command);
    },
    sendMessage(message, options) {
      if (options.triggerTurn && options.deliverAs === "followUp") messages.push(message);
    },
  };
  const configuration = privateMcpConfig(JSON.stringify({ controlSecret: "a".repeat(64) }));
  onTestFinished(configuration.remove);
  const env = { ACE_PI_SESSION_FILE: configuration.path };
  await registerAcePiExtension(pi, env);
  expect(env).not.toHaveProperty("ACE_PI_SESSION_FILE");
  const command = commands.get("ace-context");
  if (!command) throw new Error("Provider command unavailable");
  const ctx = {
    ui: { notify() {} },
    waitForIdle: async () => {},
    navigateTree: async () => ({ cancelled: false }),
  };
  const text = Buffer.from("Hello from delegated child").toString("base64");
  await expect(command.handler(`wrong ${text}`, ctx)).rejects.toThrow("Unauthorized");
  expect(messages).toEqual([]);
  await command.handler(`${"a".repeat(64)} ${text}`, ctx);
  expect(messages).toEqual([
    {
      customType: "ace.delegation.settled",
      content: "Hello from delegated child",
      display: false,
      details: { origin: "ace" },
    },
  ]);
});
