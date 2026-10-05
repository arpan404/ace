import { expect, it } from "vitest";
import { H264AccessUnits } from "./h264.ts";
const nal = (...data: number[]) => Buffer.from([0, 0, 0, 1, ...data]);
it("fragmented hardware frames retain parameter sets on every keyframe and preserve access unit order", () => {
  const packets: { payload: Buffer; key: boolean; codec: string }[] = [];
  const reader = new H264AccessUnits((payload, key, codec) =>
    packets.push({ payload, key, codec }),
  );
  const aud = nal(9, 240),
    sps = nal(103, 66, 224, 31),
    pps = nal(104, 1);
  const bytes = Buffer.concat([aud, sps, pps, nal(101, 3), aud, nal(65, 4), aud, nal(101, 5), aud]);
  for (let i = 0; i < bytes.length; i += 2) reader.push(bytes.subarray(i, i + 2));
  reader.end();
  expect(packets).toEqual([
    { payload: Buffer.concat([sps, pps, nal(101, 3)]), key: true, codec: "avc1.42e01f" },
    { payload: nal(65, 4), key: false, codec: "avc1.42e01f" },
    { payload: Buffer.concat([sps, pps, nal(101, 5)]), key: true, codec: "avc1.42e01f" },
  ]);
});
it("a malformed encoder cannot accumulate unbounded data without an AUD", () => {
  const reader = new H264AccessUnits(() => {});
  reader.push(nal(101));
  expect(() => reader.push(Buffer.alloc(8 * 1024 * 1024 + 1, 2))).toThrow("limit");
});
