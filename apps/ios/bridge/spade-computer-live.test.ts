import { SpadeDaemonLive } from "@ace/client/spade-live";
import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { SpadeComputerLive } from "./spade-computer-live.ts";
import { later, Patches, setUp } from "./spade-test-host.ts";

/*
 * A bot's computer, live, on the iPhone (#2553): its terminal follows the bot's PTY as the
 * phone's terminal output, keys typed reach the bot's shell, the stream closes when the phone
 * stops watching, and the services the bot keeps running read, log and stop.
 */

/** What Swift's terminal model holds: every byte drawn, in order, by canonical offset. */
class Screen {
  text = "";
  end = 0;
  gaps = 0;
  take(patches: Patches, id: string) {
    const patch = patches.held.get(`terminal:${id}:data`);
    patches.held.delete(`terminal:${id}:data`);
    const event = patch?.event as
      | { offset: number; endOffset: number; data: string; truncatedBefore: boolean }
      | undefined;
    if (!event) return;
    expect(event.offset).toBe(this.end);
    if (event.truncatedBefore) this.gaps++;
    this.text += event.data;
    this.end = event.endOffset;
  }
}

async function withTerminal() {
  const host = await setUp((fake) => fake.addAgent({ id: "writer", name: "Writer" }));
  await until(() => host.patches.state?.list.rows?.some((row) => row.id === "writer") === true);
  const live = new SpadeComputerLive(
    new SpadeDaemonLive(host.owner, () => crypto.randomUUID()),
    host.patches,
    later,
  );
  const screen = new Screen();
  const read = async (wanted: string) => {
    await until(() => {
      screen.take(host.patches, "t1");
      return screen.text.includes(wanted);
    });
  };
  return { ...host, live, screen, read };
}

test("a command typed on the phone runs in the bot's shell and its output draws on the phone", async () => {
  const { live, ask, read, screen } = await withTerminal();
  live.handle({ type: "spade.terminal.watch", id: "t1", agentId: "writer" });

  const typed = await ask({
    type: "spade.terminal.input",
    agentId: "writer",
    applicationCursor: false,
    input: [{ text: "ls" }, { key: "Enter" }],
  });

  expect(typed).toEqual({ ok: true });
  await read("ran: ls");
  expect(screen.text).toContain("ls\r\nran: ls");
  expect(live.streams).toBe(1);
});

test("output the bot printed before the phone looked shows once, and the stream resumes after the last drawn", async () => {
  const { live, api, daemon, read, screen } = await withTerminal();
  api.computer.print("writer", "first\r\n");
  live.handle({ type: "spade.terminal.watch", id: "t1", agentId: "writer" });
  await read("first");

  const terminal = "/v1/agents/writer/terminal/live";
  expect(daemon.spade.openStreams(terminal)).toEqual([`${terminal}?after=0`]);

  // Spade restarts the stream: it opens again after the last seq drawn, which isn't drawn again.
  daemon.spade.endStreams(terminal);
  await until(() => daemon.spade.openStreams(terminal).length === 1);
  expect(daemon.spade.openStreams(terminal)).toEqual([`${terminal}?after=1`]);
  api.computer.print("writer", "second\r\n");
  await read("second");

  expect(screen.text).toBe("first\r\nsecond\r\n");
  expect(screen.gaps).toBe(0);
});

test("the stream closes at Spade when the phone stops watching, and nothing more is put", async () => {
  const { live, api, daemon, patches, read } = await withTerminal();
  live.handle({ type: "spade.terminal.watch", id: "t1", agentId: "writer" });
  api.computer.print("writer", "hello");
  await read("hello");

  live.handle({ type: "spade.terminal.unwatch", id: "t1" });
  expect(live.streams).toBe(0);
  await until(() => daemon.spade.openStreams("/v1/agents/writer/terminal/live").length === 0);
  api.computer.print("writer", "unseen");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(patches.held.has("terminal:t1:data")).toBe(false);
});

test("a character the PTY's chunks cut in two draws once, whole", async () => {
  const { live, daemon, read, screen } = await withTerminal();
  live.handle({ type: "spade.terminal.watch", id: "t1", agentId: "writer" });
  await until(() => daemon.spade.openStreams("/v1/agents/writer/terminal/live").length === 1);
  const bytes = new TextEncoder().encode("é€ ok");
  const frame = (seq: number, part: Uint8Array) =>
    daemon.spade.emit("/v1/agents/writer/terminal/live", "output", {
      seq,
      data_b64: Buffer.from(part).toString("base64"),
    });
  // "é" is two bytes and "€" three: the first frame ends inside "€".
  frame(1, bytes.subarray(0, 3));
  await read("é");
  expect(screen.text).toBe("é");
  frame(2, bytes.subarray(3));
  await read("ok");

  expect(screen.text).toBe("é€ ok");
});

test("a service shows its state in words, its output, and stops", async () => {
  const host = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    const service = fake.services.start("writer", { name: "Preview", command: "bun run dev" });
    service.output.push("listening on 3000", "GET /");
    fake.services.start("writer", {
      name: "Build",
      command: "bun run build",
      state: "exited",
      exit_code: 2,
    });
  });
  const { ask } = host;

  const listed = await ask({ type: "spade.services", agentId: "writer" });
  if (!("services" in listed)) throw new Error(JSON.stringify(listed));
  expect(
    listed.services.map(({ name, words, running, failed }) => ({ name, words, running, failed })),
  ).toEqual([
    { name: "Preview", words: "Running", running: true, failed: false },
    { name: "Build", words: "Ended · exit 2", running: false, failed: true },
  ]);
  const preview = listed.services[0];
  if (!preview) throw new Error("no service");

  const logs = await ask({
    type: "spade.services.logs",
    agentId: "writer",
    service: preview.id,
    after: 1,
  });
  expect(logs).toEqual({ ok: true, lines: [{ n: 2, text: "GET /" }] });

  expect(
    await ask({ type: "spade.services.stop", agentId: "writer", service: preview.id }),
  ).toEqual({ ok: true });
  const again = await ask({ type: "spade.services", agentId: "writer" });
  expect(again).toMatchObject({ services: [{ words: "Stopped", running: false }, {}] });
  expect(
    await ask({ type: "spade.services.stop", agentId: "writer", service: preview.id }),
  ).toMatchObject({ ok: false, title: "Couldn't stop the service" });
});

test("an ended service starts again, and none is offered while one of its name runs", async () => {
  const host = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.services.start("writer", { name: "Build", command: "bun run build", state: "exited" });
    fake.services.start("writer", { name: "Preview", command: "bun run dev", state: "stopped" });
    fake.services.start("writer", { name: "Preview", command: "bun run dev" });
  });
  const { ask } = host;
  const listed = await ask({ type: "spade.services", agentId: "writer" });
  if (!("services" in listed)) throw new Error(JSON.stringify(listed));
  expect(listed.services.map(({ name, startable }) => ({ name, startable }))).toEqual([
    { name: "Build", startable: true },
    { name: "Preview", startable: false },
    { name: "Preview", startable: false },
  ]);
  const [build, oldPreview] = listed.services;
  if (!build || !oldPreview) throw new Error("no service");

  expect(await ask({ type: "spade.services.start", agentId: "writer", service: build.id })).toEqual(
    { ok: true },
  );
  const again = await ask({ type: "spade.services", agentId: "writer" });
  expect(again).toMatchObject({ services: [{ words: "Running", running: true }, {}, {}] });
  expect(
    await ask({ type: "spade.services.start", agentId: "writer", service: oldPreview.id }),
  ).toMatchObject({ ok: false, title: "Couldn't start the service" });
});
