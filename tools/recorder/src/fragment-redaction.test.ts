import { expect, test } from "vitest";
import { z } from "zod";
import { createRecordingRedactor } from "./fragment-redaction.ts";

const context = {
  home: "/Users/private-person",
  workspace: "/private/var/folders/ab/private-temp-id/T/ace-rec-disposable",
  username: "private-person",
  host: "private-host",
};
const Fragment = z.object({
  seq: z.number(),
  data: z.object({ body: z.object({ text: z.string() }) }),
});
function record(seq: number, text: string, agentId = "agent") {
  return JSON.stringify({
    seq,
    threadId: "thread",
    data: { kind: "delta", agentId, body: { type: "text", text } },
  });
}
function captured(parts: string[]) {
  const redact = createRecordingRedactor(context);
  return [...parts.flatMap((text, seq) => redact.push(record(seq, text))), ...redact.finish()].map(
    (line) => Fragment.parse(JSON.parse(line)),
  );
}

test("home and disposable temp paths are redacted across every possible fragment split", () => {
  const text = `Read ${context.home}/.config and ${context.workspace}/src/file.ts then continue.\n`;
  for (let split = 1; split < text.length; split++) {
    const frames = captured([text.slice(0, split), text.slice(split)]);
    expect(frames.map((frame) => frame.seq)).toEqual([0, 1]);
    expect(frames.map((frame) => frame.data.body.text).join("")).toBe(
      "Read <HOME>/.config and <WORKSPACE>/src/file.ts then continue.\n",
    );
  }
});

test("fragment carry is bounded and never publishes an unfinished path or its continuation", () => {
  const frames = captured([
    ...Array.from(
      "/private/var/folders/ab/" + "private-temp-id".repeat(300) + "/T/ace-rec-disposable",
    ),
    " done\n",
  ]);
  const text = frames.map((frame) => frame.data.body.text).join("");
  expect(text).toContain("<FRAGMENT OMITTED>");
  expect(text).not.toMatch(/private|disposable|var\/folders/);
  expect(text).toContain(" done\n");
});

test("interleaved control frames and independent agents cannot combine each other's text", () => {
  const redact = createRecordingRedactor(context);
  const lines = [
    record(0, "/Users/private-"),
    JSON.stringify({ seq: 1, note: "control" }),
    record(2, "safe text\n", "other"),
    record(3, "person/.config\n"),
  ];
  const frames = [...lines.flatMap((line) => redact.push(line)), ...redact.finish()].map((line) =>
    JSON.parse(line),
  );
  expect(JSON.stringify(frames)).not.toMatch(/private-person|person\/\.config/);
  expect(frames).toContainEqual({ seq: 1, note: "control" });
  expect(Fragment.parse(frames[2]).data.body.text).toBe("safe text\n");
});
