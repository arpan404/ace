import { expect, it, vi } from "vitest";
import { cursorFixture, executablePath } from "./cursor-test-support.ts";
import { Snapshot } from "./test-support.ts";

const test = it.skipIf(!executablePath);

/** Dark pixels (text, bullets) inside a CSS box of a viewport image. */
async function inkIn(
  image: { data: string; width: number },
  box: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const { default: sharp } = await import("sharp");
  const scale = image.width / 800;
  const { data, info } = await sharp(Buffer.from(image.data, "base64"))
    .extract({
      left: Math.round(box.x * scale),
      top: Math.round(box.y * scale),
      width: Math.round(box.width * scale),
      height: Math.round(box.height * scale),
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let index = 0; index < data.length; index += info.channels)
    if (Math.max(data[index] ?? 255, data[index + 1] ?? 255, data[index + 2] ?? 255) < 100) dark++;
  return dark;
}

test("password fields are blank in agent screenshots and snapshots, and only there", async () => {
  const f = await cursorFixture();
  await f.personRun({ action: "navigate", url: `${f.origin}/login` });
  await f.personRun({
    action: "evaluate",
    expression: "password.value = 'hunter2'; shown.value = 'hunter2'; true",
  });
  const password = await f.box("#password");
  const shown = await f.box("#shown");
  // The person still sees what they typed: bullets in one field, the text in the other.
  await vi.waitFor(
    async () => {
      // A still page sends no new frame; nudge a repaint so the newest frame shows the fields.
      await f.personRun({
        action: "evaluate",
        expression:
          "document.body.style.background = document.body.style.background ? '' : '#fefefe'; true",
      });
      const live = await f.frameImage();
      expect(await inkIn(live, password)).toBeGreaterThan(20);
      expect(await inkIn(live, shown)).toBeGreaterThan(20);
    },
    { timeout: 15_000, interval: 200 },
  );
  const shot = await f.bytesImage(
    await f.service.screenshot(
      "thread",
      undefined,
      undefined,
      {},
      {
        kind: "agent",
        agentId: "helper",
      },
    ),
  );
  expect(await inkIn(shot, password)).toBe(0);
  expect(await inkIn(shot, shown)).toBe(0);
  const snapshot = Snapshot.parse(await f.agentRun({ action: "snapshot" }));
  expect(JSON.stringify(snapshot)).not.toContain("hunter2");
  expect(snapshot.nodes.find((node) => node.name === "Shown password")?.value).toBe("••••••••");
  // The page itself is untouched.
  expect(await f.personRun({ action: "evaluate", expression: "shown.value" })).toBe("hunter2");
}, 60_000);

test("people see that an agent is recording the tab and can stop it", async () => {
  const f = await cursorFixture();
  await f.agentRun({ action: "record_start" });
  await vi.waitFor(() =>
    expect(f.states.at(-1)?.recording).toEqual({ by: { kind: "agent", agentId: "helper" } }),
  );
  const artifact = await f.service.stopRecording("thread", {
    kind: "human",
    connectionId: "person",
  });
  expect(artifact.bytes).toBeGreaterThan(0);
  await vi.waitFor(() => expect(f.states.at(-1)?.recording).toBeUndefined());
}, 60_000);
