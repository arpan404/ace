import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BrowserDownloadRead, type BrowserServerMessage } from "@ace/protocol";
import { BrowserService, connectBrowser, detectChromium } from "./index.ts";
import {
  decodeStreamMessage,
  downloadBusy,
  StreamAssembler,
  type DownloadChunkMessage,
} from "./stream.ts";
import { ref } from "./test-support.ts";

const executablePath = await detectChromium();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
}, 60_000);

/** A PDF-sized file: several chunks, and bytes that differ along it. */
const report = Buffer.from(
  Uint8Array.from({ length: 700 * 1024 }, (_, index) => (index * 7) % 253),
);

const html = (response: ServerResponse, body: string) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><meta charset="utf-8">${body}`);
};

/** ace's Chrome on a page with a drop zone and a download, and the person's connections to it. */
async function transfers() {
  const home = await mkdtemp(join(tmpdir(), "ace-file-transfer-"));
  const server = createServer((request, response) => {
    if (request.url === "/report.pdf") {
      response.writeHead(200, {
        "Content-Disposition": "attachment; filename=report.pdf",
        "Content-Type": "application/pdf",
      });
      response.end(report);
      return;
    }
    html(
      response,
      `<title>Upload</title><a href="/report.pdf">Report</a>
<div id="zone" style="position:fixed;left:0;top:40px;width:400px;height:300px">Drop here</div>
<p id="out">nothing dropped</p>
<script>
const zone=document.getElementById('zone');
zone.addEventListener('dragover',(event)=>event.preventDefault());
zone.addEventListener('drop',async(event)=>{event.preventDefault();const files=[...event.dataTransfer.files];document.getElementById('out').textContent+=' dropped '+(await Promise.all(files.map(async(file)=>file.name+': '+(await file.text())))).join(', ')});
</script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const service = new BrowserService({
    dataDir: home,
    ...(executablePath ? { executablePath } : {}),
    workspaceRoot: () => home,
  });
  /** Files the person's device uploaded as thread attachments, by sha256. */
  const attachments = new Map<string, Buffer>();
  const connections: (() => void)[] = [];
  cleanups.push(async () => {
    for (const close of connections) close();
    try {
      await service.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
  await service.open({ threadId: "thread", workspaceId: "workspace" });
  const agent = { kind: "agent" as const, agentId: "agent-1" };
  const execute = (command: Record<string, unknown>) => service.execute("thread", command, agent);
  await execute({ action: "navigate", url: `http://127.0.0.1:${address.port}/` });

  /** One client connection of the person's, with its binary stream messages decoded. */
  const connect = (id: string, room: () => boolean = () => true) => {
    const messages: BrowserServerMessage[] = [];
    const chunks: DownloadChunkMessage[] = [];
    const assembler = new StreamAssembler();
    let request = 0;
    const bridge = connectBrowser(service, {
      connectionId: id,
      authorize: () => true,
      attachment: async (_threadId, sha256) => {
        const bytes = attachments.get(sha256);
        if (!bytes) throw new Error("Thread attachment unavailable");
        return {
          chunks: (async function* () {
            yield bytes;
          })(),
          close: async () => {},
        };
      },
      send: (message) => {
        messages.push(message);
        return true;
      },
      sendStream: (pieces) => {
        if (!room()) return false;
        for (const piece of pieces) {
          const envelope = assembler.push(piece);
          const message = envelope && decodeStreamMessage(envelope);
          if (message?.kind === "browser.download.chunk") chunks.push(message);
        }
        return true;
      },
    });
    connections.push(() => bridge.close());
    return {
      chunks,
      close: () => bridge.close(),
      async send(message: Record<string, unknown>): Promise<unknown> {
        const requestId = `${id}-${++request}`;
        await bridge.handle({ requestId, threadId: "thread", ...message });
        const result = messages.find(
          (candidate) => candidate.type === "browser.result" && candidate.requestId === requestId,
        );
        if (result?.type !== "browser.result") throw new Error("No browser result");
        if (!result.ok) throw new Error(result.error);
        return result.result;
      },
    };
  };
  return {
    home,
    service,
    attachments,
    connect,
    execute,
    text: async () =>
      z
        .string()
        .parse(await execute({ action: "evaluate", expression: "document.body.innerText" })),
  };
}

it.skipIf(!executablePath)(
  "files dropped on the remote view reach the page's own drop zone at the drop point",
  async () => {
    const f = await transfers();
    const person = f.connect("person");
    const tabId = f.service.state("thread").activeTabId;
    const text = "hello from my laptop";
    const sha256 = createHash("sha256").update(text).digest("hex");
    f.attachments.set(sha256, Buffer.from(text));
    // Dropped outside the zone, the page never gets a drop, as in a browser.
    await person.send({
      type: "browser.files.drop",
      tabId,
      x: 600,
      y: 20,
      files: [{ sha256, name: "elsewhere.txt" }],
    });
    await person.send({
      type: "browser.files.drop",
      tabId,
      x: 100,
      y: 120,
      files: [{ sha256, name: "notes.txt" }],
    });
    await expect
      .poll(() => f.text(), { timeout: 15_000 })
      .toContain("dropped notes.txt: hello from my laptop");
    expect(await f.text()).not.toContain("elsewhere.txt");

    // Closing the browser removes what was dropped from the daemon's disk.
    await f.service.closeThread("thread", { kind: "human", connectionId: "person" });
    const sessions = await readdir(join(f.home, "browser", "threads"), { recursive: true });
    expect(sessions.filter((path) => path.includes("dropped-files"))).toEqual([]);
  },
  60_000,
);

it.skipIf(!executablePath)(
  "a finished download is fetched to the device in chunks and resumes on a new connection",
  async () => {
    const f = await transfers();
    await f.execute({
      action: "click",
      ref: ref(await f.execute({ action: "snapshot" }), "Report"),
    });
    await expect
      .poll(() => f.service.downloadsList("thread")[0]?.state, { timeout: 20_000 })
      .toBe("complete");
    const downloadId = f.service.downloadsList("thread")[0]?.downloadId;

    // The first connection gets two chunks, then drops.
    const first = f.connect("phone-1");
    const read = async (
      connection: ReturnType<typeof f.connect>,
      offset: number,
      validator?: string,
    ) =>
      BrowserDownloadRead.parse(
        await connection.send({
          type: "browser.download.read",
          downloadId,
          offset,
          length: 256 * 1024,
          ...(validator ? { validator } : {}),
        }),
      );
    const one = await read(first, 0);
    const two = await read(first, one.bytes, one.validator);
    expect(one).toMatchObject({ offset: 0, size: report.length, done: false });
    first.close();

    // The phone reconnects and asks for the rest from where it stopped, for the same file.
    const backedUp = { full: true };
    const second = f.connect("phone-2", () => !backedUp.full);
    // A connection with no room for the chunk says so; the client asks again.
    await expect(read(second, one.bytes + two.bytes, two.validator)).rejects.toThrow(downloadBusy);
    backedUp.full = false;
    const three = await read(second, one.bytes + two.bytes, two.validator);
    expect(three).toMatchObject({ done: true, size: report.length });

    const received = [...first.chunks, ...second.chunks];
    expect(received.map((chunk) => chunk.offset)).toEqual([0, one.bytes, one.bytes + two.bytes]);
    expect(Buffer.concat(received.map((chunk) => chunk.bytes))).toEqual(report);

    // Only this thread's own downloads can be read, and a stale validator is refused.
    await expect(read(second, 0, "1-2-3")).rejects.toThrow(/changed/);
    await expect(
      second.send({ type: "browser.download.read", downloadId: "../../etc/passwd", offset: 0 }),
    ).rejects.toThrow(/No finished download/);
  },
  60_000,
);
