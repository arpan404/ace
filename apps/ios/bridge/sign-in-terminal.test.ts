import { afterEach, expect, test } from "vitest";
import { ProviderLoginResult } from "@ace/protocol";
import { NativeTerminal } from "./native-terminal.ts";
import { writeNativeTerminalInput } from "./native-terminal-input.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * A CLI's own sign-in in its live auth terminal, which belongs to no thread: the phone shows
 * its output and types into it, and the sign-in finishes when the CLI exits.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
});

test("the phone types into a CLI's sign-in terminal and the sign-in finishes", async () => {
  const { client } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const login = async (request: Parameters<typeof client.request>[0]) => {
    const reply = ProviderLoginResult.parse(await client.request(request));
    if (!reply.result.ok) throw new Error(reply.result.error);
    return reply.result.progress;
  };
  const started = await login({ type: "provider.login.start", provider: "pi" });
  const chose = await login({
    type: "provider.login.input",
    session: started.session,
    input: { choice: "other" },
  });
  const terminalId = chose.manual?.terminalId;
  if (!terminalId) throw new Error("expected Pi's sign-in terminal");
  expect(chose.manual?.instruction).toMatch(/Type \/login/);

  const sink = new RecordingSink();
  const terminal = new NativeTerminal(client, sink);
  terminal.handle({ type: "terminal.watch", id: "sign-in", terminalId, offset: 0 });
  await until(() => sink.read("terminal:sign-in:data") !== undefined, "terminal output");
  expect(JSON.stringify(sink.read("terminal:sign-in:data"))).toContain("Pi ready");

  const typed = await writeNativeTerminalInput(
    client,
    {
      type: "terminal.input",
      terminalId,
      applicationCursor: false,
      input: [{ text: "/exit" }, { key: "Enter" }],
    },
    new AbortController().signal,
  );
  expect(typed).toMatchObject({ ok: true });
  await until(() => sink.read("terminal:sign-in:exit") !== undefined, "CLI exit");
  const finished = await login({ type: "provider.login.poll", session: started.session });
  expect(finished.state).toBe("succeeded");
});
