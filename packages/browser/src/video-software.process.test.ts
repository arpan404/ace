import { expect, test } from "vitest";
import { z } from "zod";
import { connectBrowser } from "./index.ts";
import { decodeStreamMessage, StreamAssembler } from "./stream.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import { executablePath, fixture } from "./test-support.ts";

// This baseline deliberately selects a software codec. Hardware codec quality
// and desktop capture are separate gates; this proves real bytes can play.
test.skipIf(!executablePath && process.platform !== "win32")(
  "a software video viewer decodes real frames and keeps playing after acknowledgements",
  async () => {
    if (!executablePath)
      throw new Error("Windows streaming checks require a real Chrome executable");
    const f = await fixture();
    await f.navigate();
    await f.execute({ action: "resize", width: 320, height: 200 });
    const assembler = new StreamAssembler();
    const chunks: BrowserVideoChunk[] = [];
    const waiters = new Set<() => void>();
    let problem: Error | undefined;
    let jpeg = false;
    const bridge = connectBrowser(f.service, {
      connectionId: "software-viewer",
      authorize: () => true,
      send: (message) => {
        if (message.type === "browser.result" && !message.ok && message.error) {
          problem = new Error(message.error);
          for (const waiter of waiters) waiter();
        }
        if (message.type === "browser.frame") jpeg = true;
        return true;
      },
      sendStream: (pieces) => {
        for (const piece of pieces) {
          const envelope = assembler.push(piece);
          const message = envelope && decodeStreamMessage(envelope);
          if (message?.kind === "browser.video") chunks.push(message.chunk);
          if (message?.kind === "browser.frame") jpeg = true;
        }
        for (const waiter of waiters) waiter();
        return true;
      },
    });
    const until = (ready: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (problem) {
            clearTimeout(timer);
            waiters.delete(check);
            reject(problem);
            return;
          }
          if (!ready()) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Software video stalled after ${chunks.length} encoded chunks`));
        }, 20_000);
        waiters.add(check);
        check();
      });
    try {
      await bridge.handle({
        type: "browser.subscribe",
        threadId: "thread",
        requestId: "subscribe",
        binaryFrames: true,
        viewport: { width: 320, height: 200, devicePixelRatio: 1 },
        video: { codecs: ["vp8"] },
      });
      await f.evaluate(`window.streaming=true; window.tick=0;
      (function draw(){if(!window.streaming)return;
      document.body.style.background='rgb('+(++window.tick%255)+',40,90)';
      requestAnimationFrame(draw)})(); 1`);
      await until(() => chunks.length > 0);
      for (let index = 0; index < 3; index++) {
        const last = chunks.at(-1);
        if (!last) throw new Error("Missing video chunk");
        const count = chunks.length;
        await bridge.handle({
          type: "browser.ack",
          threadId: "thread",
          requestId: `ack-${index}`,
          sequence: last.sequence,
          video: true,
        });
        await until(() => chunks.length > count);
      }
      const played = chunks.slice();
      expect(played[0]).toMatchObject({
        key: true,
        codec: "vp8",
        codedWidth: 320,
        codedHeight: 200,
      });
      expect(played.some((chunk) => !chunk.key)).toBe(true);
      expect(jpeg).toBe(false);
      const input = played.map((chunk) => ({
        key: chunk.key,
        sequence: chunk.sequence,
        data: Buffer.from(chunk.bytes).toString("base64"),
      }));
      const result = await f.evaluate(`(async()=>{
      const pictures=[],errors=[];
      const decoder=new VideoDecoder({output:frame=>{
        pictures.push([frame.codedWidth,frame.codedHeight]);frame.close();
      },error:error=>errors.push(String(error))});
      try {
        decoder.configure({codec:'vp8',codedWidth:320,codedHeight:200});
        for(const chunk of ${JSON.stringify(input)})decoder.decode(new EncodedVideoChunk({
          type:chunk.key?'key':'delta',timestamp:chunk.sequence,
          data:Uint8Array.from(atob(chunk.data),c=>c.charCodeAt(0))}));
        await decoder.flush();
        return JSON.stringify({pictures,errors});
      } finally {decoder.close();}
    })()`);
      const decoded = z
        .object({
          pictures: z.array(z.tuple([z.number(), z.number()])),
          errors: z.array(z.string()),
        })
        .parse(JSON.parse(z.string().parse(result)));
      expect(decoded.errors).toEqual([]);
      expect(decoded.pictures).toEqual(played.map(() => [320, 200]));
    } finally {
      bridge.close();
    }
  },
  90_000,
);
