import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager } from "./index.ts";
import type {
  Terminal,
  TerminalAttachment,
  TerminalEvent,
  TerminalManagerOptions,
} from "./index.ts";

export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function fixture(options: TerminalManagerOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-terminal-"));
  await writeFile(
    join(home, ".bash_profile"),
    "PS1=''; unset PROMPT_COMMAND; stty -echo; printf '__READY__\\n'\n",
  );
  await writeFile(
    join(home, ".inputrc"),
    "set enable-bracketed-paste off\nset enable-meta-key off\n",
  );
  const manager = new TerminalManager({ graceMs: 0, ...options });
  const terminal = manager.openTerminal({
    cwd: home,
    shell: "/bin/bash",
    env: { HOME: home, INPUTRC: join(home, ".inputrc"), BASH_SILENCE_DEPRECATION_WARNING: "1" },
    cols: 80,
    rows: 24,
    name: "test",
  });
  const attachment = terminal.attach();
  await until(attachment, "__READY__\r\n");
  terminal.write("printf '__BOOTED__\\n'\r");
  const ready = await until(attachment, "__BOOTED__\r\n");
  return {
    home,
    manager,
    terminal,
    attachment,
    ready,
    async cleanup() {
      attachment.detach();
      await manager.closeAll();
      await rm(home, { recursive: true, force: true });
    },
  };
}

export async function until(attachment: TerminalAttachment, marker: string): Promise<string> {
  let output = "";
  for (;;) {
    const event = await attachment.next();
    if (event.done || event.value.type !== "data")
      throw new Error(`Terminal ended before ${marker}: ${output}`);
    output += event.value.data;
    if (output.includes(marker)) return output;
  }
}

export async function collect(attachment: TerminalAttachment): Promise<TerminalEvent[]> {
  const events: TerminalEvent[] = [];
  for await (const event of attachment) events.push(event);
  return events;
}

export function runNode(terminal: Terminal, source: string): void {
  terminal.write(`${quote(process.execPath)} -e ${quote(source)}\r`);
}
