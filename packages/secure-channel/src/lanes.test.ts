import { expect, it } from "vitest";
import {
  BULK,
  FULL_FRAGMENT,
  FragmentAssembler,
  INTERACTIVE,
  MAX_PASSED_FRAGMENTS,
  fragmentFlag,
  fragmentKinds,
  type FragmentKind,
  type Lane,
} from "./lanes.ts";

const limits = { binaryLimit: 64 * 1024 + 16, logicalLimit: 16 * 1024 * 1024 };

/** A message's fragments as a sender frames them. */
function fragments(bytes: Uint8Array, kind: FragmentKind, lane: Lane): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += FULL_FRAGMENT - 1) {
    const chunk = bytes.subarray(offset, offset + FULL_FRAGMENT - 1);
    const plain = new Uint8Array(chunk.length + 1);
    plain[0] = fragmentFlag(kind, offset + chunk.length === bytes.length, lane);
    plain.set(chunk, 1);
    out.push(plain);
  }
  return out;
}

const filled = (length: number, value: number) => new Uint8Array(length).fill(value);

it("interactive fragments between a bulk message's fragments reassemble into both messages", () => {
  const assembler = new FragmentAssembler({ lanes: true, ...limits });
  const bulk = fragments(filled(3 * FULL_FRAGMENT, 7), fragmentKinds.json, BULK);
  const approval = fragments(filled(600, 9), fragmentKinds.json, INTERACTIVE);
  const arrived = [bulk[0], ...approval, bulk[1], bulk[2], bulk[3]].flatMap((plain) => {
    const whole = plain && assembler.add(plain);
    return whole ? [whole] : [];
  });
  expect(arrived.map((message) => [message.data.length, message.data[0]])).toEqual([
    [600, 9],
    [3 * FULL_FRAGMENT, 7],
  ]);
});

it("without lanes framing, a fragment is exactly the old framing and a lane bit is refused", () => {
  const plain = fragments(filled(10, 1), fragmentKinds.binary, INTERACTIVE)[0];
  expect(plain?.[0]).toBe(3);
  const assembler = new FragmentAssembler({ lanes: false, ...limits });
  const [bulk] = fragments(filled(10, 1), fragmentKinds.json, BULK);
  if (!bulk) throw new Error("Expected a fragment");
  expect(() => assembler.add(bulk)).toThrow("Invalid encrypted fragment");
});

it("a message's fragments still come back to back within their lane", () => {
  const assembler = new FragmentAssembler({ lanes: true, ...limits });
  const [first] = fragments(filled(2 * FULL_FRAGMENT, 1), fragmentKinds.json, BULK);
  const [binary] = fragments(filled(10, 2), fragmentKinds.binary, BULK);
  if (!first || !binary) throw new Error("Expected fragments");
  assembler.add(first);
  expect(() => assembler.add(binary)).toThrow("Mixed fragment kinds");
});

it("a short fragment that is not its message's last is refused in either lane", () => {
  for (const lane of [INTERACTIVE, BULK] as const) {
    const assembler = new FragmentAssembler({ lanes: true, ...limits });
    const truncated = new Uint8Array(100);
    truncated[0] = fragmentFlag(fragmentKinds.json, false, lane);
    expect(() => assembler.add(truncated)).toThrow("Invalid encrypted fragment");
  }
});

it("a binary message past its limit is refused", () => {
  const assembler = new FragmentAssembler({ lanes: true, ...limits });
  const pieces = fragments(filled(2 * FULL_FRAGMENT, 1), fragmentKinds.binary, BULK);
  expect(() => pieces.forEach((plain) => assembler.add(plain))).toThrow("Binary message too large");
});

it("a bulk partial message passed by too many interactive fragments ends the channel", () => {
  const assembler = new FragmentAssembler({ lanes: true, ...limits });
  const [first] = fragments(filled(2 * FULL_FRAGMENT, 1), fragmentKinds.json, BULK);
  if (!first) throw new Error("Expected a fragment");
  assembler.add(first);
  const small = () => fragments(filled(10, 2), fragmentKinds.json, INTERACTIVE)[0] ?? filled(0, 0);
  for (let index = 0; index < MAX_PASSED_FRAGMENTS; index++) assembler.add(small());
  expect(() => assembler.add(small())).toThrow("Partial message starved");
});
