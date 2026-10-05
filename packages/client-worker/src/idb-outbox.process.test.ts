import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { expect, test } from "vitest";
import { z } from "zod";

/** Native IndexedDB, a fresh browser profile and a loopback origin; no app or provider process. */
async function browserStorage(
  run: (evaluate: (source: string) => Promise<unknown>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "ace-idb-outbox-"));
  try {
    const bundle = join(root, "adapter.js");
    await promisify(execFile)("bun", [
      "build",
      fileURLToPath(new URL("./idb-outbox.ts", import.meta.url)),
      "--target=browser",
      `--outfile=${bundle}`,
    ]);
    const source = await readFile(bundle, "utf8");
    const server = createServer((request, response) => {
      response.setHeader(
        "content-type",
        request.url === "/adapter.js" ? "application/javascript" : "text/html",
      );
      response.end(
        request.url === "/adapter.js" ? source : "<!doctype html><title>Storage edge</title>",
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected loopback server");
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}`);
        await run((sourceText) => page.evaluate(sourceText));
      } finally {
        await browser.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("concurrent IndexedDB writers preserve each send and reload every Unicode command ID in its scope", async () => {
  await browserStorage(async (evaluate) => {
    const result = z
      .object({
        ids: z.array(z.string()),
        other: z.array(z.string()),
        removed: z.array(z.string()),
      })
      .parse(
        await evaluate(`(async () => {
        const { idbOutbox } = await import('/adapter.js');
        const a = idbOutbox('machine:device');
        const b = idbOutbox('machine:device');
        const other = idbOutbox('machine:device:other');
        await Promise.all([a.records.load(), b.records.load(), other.records.load()]);
        const ids = ['\\uffffx', 'emoji-😀', 'ascii'];
        const row = id => JSON.stringify({ command: { id, deviceId: 'device',
          payload: { type: 'thread.send', threadId: 'thread', input: [{type:'text',text:id}] } }, state: 'pending' });
        await Promise.all([a.records.write(ids[0],row(ids[0])), b.records.write(ids[1],row(ids[1])),
          a.records.write(ids[2],row(ids[2])), other.records.write('elsewhere',row('elsewhere'))]);
        const load = async key => (await idbOutbox(key).records.load()).map(raw => JSON.parse(raw).command.id).sort();
        const loaded = await load('machine:device');
        await b.records.write(ids[0], null);
        return { ids: loaded, other: await load('machine:device:other'), removed: await load('machine:device') };
      })()`),
      );
    expect(result.ids).toEqual(["ascii", "emoji-😀", "\uffffx"]);
    expect(result.other).toEqual(["elsewhere"]);
    expect(result.removed).toEqual(["ascii", "emoji-😀"]);
  });
});

test("IndexedDB migration preserves ordered full drafts once and never resurrects deleted legacy sends", async () => {
  await browserStorage(async (evaluate) => {
    const result = z
      .object({
        first: z.array(
          z.object({
            command: z.object({
              id: z.string(),
              payload: z.object({ input: z.array(z.unknown()) }),
            }),
            order: z.number(),
          }),
        ),
        again: z.array(z.object({ command: z.object({ id: z.string() }) })),
      })
      .parse(
        await evaluate(`(async () => {
        const { idbOutbox } = await import('/adapter.js');
        const draft = id => ({ command: { id, deviceId: 'device', payload: { type: 'thread.send', threadId: 'thread',
          input: [{ type: 'text', text: 'Full draft' }, { type: 'image', mimeType: 'image/png', url: 'data:image/png;base64,AQ==' }], effort: 'high' } }, state:'pending' });
        const old = await new Promise((resolve,reject) => { const r=indexedDB.open('ace',1);
          r.onupgradeneeded=()=>r.result.createObjectStore('outbox'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
        await new Promise((resolve,reject) => { const tx=old.transaction('outbox','readwrite');
          tx.objectStore('outbox').put(JSON.stringify([draft('z-first'), draft('a-second')]),'migration');
          tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); }); old.close();
        const a=idbOutbox('migration'); const b=idbOutbox('migration');
        await Promise.all([a.records.load(),b.records.load()]);
        const first=(await a.records.load()).map(JSON.parse).sort((a,b)=>a.order-b.order);
        await a.records.write('z-first',null);
        const again=(await idbOutbox('migration').records.load()).map(JSON.parse);
        return { first, again };
      })()`),
      );
    expect(result.first.map((row) => row.command.id)).toEqual(["z-first", "a-second"]);
    expect(result.first[0]?.command.payload.input).toEqual([
      { type: "text", text: "Full draft" },
      { type: "image", mimeType: "image/png", url: "data:image/png;base64,AQ==" },
    ]);
    expect(result.again.map((row) => row.command.id)).toEqual(["a-second"]);
  });
});
