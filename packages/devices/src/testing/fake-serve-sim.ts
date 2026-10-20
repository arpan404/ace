import { chmod, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import sharp from "sharp";
import { WebSocketServer } from "ws";
import { onTestFinished } from "vitest";

export const description = Buffer.from(
  "01640033ffe1001627640033ac13143c04c0149e6a9a81010103c20108f801000428ee3cb0",
  "hex",
);
const record = (tag: number, body: Buffer) => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1);
  head[4] = tag;
  return Buffer.concat([head, body]);
};
const unit = (nal: number[]) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(nal.length);
  return Buffer.concat([length, Buffer.from(nal)]);
};
const ax = [
  {
    type: "Application",
    AXLabel: "Settings",
    enabled: true,
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      {
        type: "Button",
        AXLabel: "General",
        enabled: true,
        frame: { x: 0, y: 300, width: 402, height: 50 },
        children: [],
      },
    ],
  },
];

/**
 * A stand-in for serve-sim: a CLI announcing one helper for `udid`, which serves MJPEG, AVCC,
 * `/ax` (a Settings screen with a General row) and the HID socket on one port.
 */
export async function fakeServeSim(home: string, version: string, udid: string) {
  const base = `/helper/${udid}`;
  const avcc: ServerResponse[] = [];
  let avccOpened = 0;
  let mjpegOpen = 0;
  const jpeg = await sharp({
    create: { width: 201, height: 437, channels: 3, background: "white" },
  })
    .jpeg()
    .toBuffer();
  const server = createServer((req, res) => {
    if (req.url === `${base}/stream.mjpeg`) {
      mjpegOpen++;
      res.on("close", () => mjpegOpen--);
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      return;
    }
    if (req.url === `${base}/stream.avcc`) {
      avccOpened++;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      avcc.push(res);
      res.on("close", () => avcc.splice(avcc.indexOf(res), 1));
      // Like serve-sim: a preview seed, then the description and an IDR for every subscriber.
      res.write(record(4, jpeg));
      res.write(Buffer.concat([record(1, description), record(2, unit([0x25, 0x88, avccOpened]))]));
      return;
    }
    if (req.url === `${base}/ax`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ax));
      return;
    }
    res.writeHead(404).end();
  });
  const hid: unknown[] = [];
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket) => {
    socket.send(
      Buffer.concat([
        Buffer.from([130]),
        Buffer.from(JSON.stringify({ width: 1206, height: 2622, orientation: "portrait" })),
      ]),
    );
    socket.on("message", (bytes: Buffer) =>
      hid.push([bytes[0], JSON.parse(bytes.subarray(1).toString())]),
    );
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    }),
  );
  const command = join(home, "serve-sim");
  await writeFile(
    command,
    `#!${process.execPath}\nif(process.argv.includes('--version')){console.log(${JSON.stringify(version)});process.exit(0);}console.log(JSON.stringify({device:${JSON.stringify(udid)},port:${port},streamUrl:'http://127.0.0.1:${port}${base}/stream.mjpeg',wsUrl:'ws://127.0.0.1:${port}${base}/ws'}));process.stdin.resume();`,
  );
  await chmod(command, 0o700);
  for (const name of ["xcode-select", "xcrun", "open"]) {
    await writeFile(join(home, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(home, name), 0o700);
  }
  onTestFinished(async () => {
    server.closeAllConnections();
    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    command,
    hid,
    avcc,
    opened: () => avccOpened,
    mjpegOpen: () => mjpegOpen,
    delta: (byte: number) => avcc.at(-1)?.write(record(3, unit([0x21, byte]))),
    /** Announces a new screen orientation, as serve-sim does after a rotate request. */
    orient: (orientation: string) => {
      for (const socket of ws.clients)
        socket.send(
          Buffer.concat([
            Buffer.from([130]),
            Buffer.from(JSON.stringify({ width: 1206, height: 2622, orientation })),
          ]),
        );
    },
  };
}
