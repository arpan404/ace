import { Store } from "../store.ts";
import { expect, test } from "vitest";
import { CommandLibrary } from "@ace/commands";
import { Command, ThreadId, type ContentPart } from "@ace/protocol";
import { harness, scriptFrames, start, end } from "./test-support.ts";
import { join } from "node:path";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { prepareQueuedInput } from "../services/recovery.ts";

test("a Claude skill stays a native command and an ace skill arrives as its SKILL.md body while the transcript keeps both chips", async () => {
  let library: CommandLibrary | undefined;
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    provider: "claude",
    prepareInput: (...args) => {
      if (!library) throw new Error("Catalog missing");
      return prepareQueuedInput({ services: { commands: library } })(...args);
    },
  });
  const root = await realpath(h.home);
  const directory = join(root, ".claude/skills/review");
  await mkdir(directory, { recursive: true });
  await mkdir(join(root, "provider"));
  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: review\ndescription: Review branch changes\n---\nReview",
  );
  const aceSkill = join(root, "skills/house-style");
  await mkdir(aceSkill, { recursive: true });
  await writeFile(
    join(aceSkill, "SKILL.md"),
    "---\nname: house-style\ndescription: Our writing rules\n---\nFollow rules.md exactly.\n",
  );
  library = new CommandLibrary({
    aceHome: root,
    instances: [{ id: "claude", provider: "claude", home: join(root, "provider") }],
    context: () => ({ workspace: root, provider: "claude", instance: "claude" }),
    now: () => h.clock.now(),
  });
  try {
    const id = await h.create();
    await library.list(id, "review", 20);
    const catalog = await library.listCatalog(id, "review", 20);
    const skill = catalog.entries.find((e) => e.kind === "skill");
    if (!skill) throw new Error("Missing discovered skill");
    const house = (await library.listCatalog(id, "house", 20)).entries.find(
      (e) => e.kind === "skill" && e.source.provider === "ace",
    );
    if (!house) throw new Error("Missing ace skill");
    const input: ContentPart[] = [
      { type: "text", text: "Please " },
      { type: "mention", entryId: skill.id, name: skill.name, kind: "skill", arguments: "" },
      { type: "text", text: " in " },
      { type: "mention", entryId: house.id, name: house.name, kind: "skill", arguments: "" },
      { type: "text", text: " before editing." },
    ];
    const command = Command.parse({
      id: "mention-send",
      deviceId: "person",
      payload: { type: "thread.send", threadId: id, input },
    });
    expect(h.command(command.payload, "person", "mention-send")).toMatchObject({ ok: true });
    await h.engine.flush();
    await expect
      .poll(() =>
        h.adapter.commands.some(
          (c) => c.type === "send" && c.input.some((p) => p.type === "mention"),
        ),
      )
      .toBe(true);
    const sent = h.adapter.commands.find(
      (c) => c.type === "send" && c.input.some((p) => p.type === "mention"),
    );
    const housePath = join(aceSkill, "SKILL.md");
    const block = [
      `<skill name="house-style" path=${JSON.stringify(housePath)}>`,
      `The person selected the "house-style" skill for this message. Follow its instructions below. Resolve relative paths in it against ${JSON.stringify(aceSkill)}.`,
      "",
      "Follow rules.md exactly.",
      "</skill>",
    ].join("\n");
    expect(sent).toMatchObject({
      type: "send",
      input: [
        { type: "text", text: `${block}\n\nPlease ` },
        { type: "mention", entryId: skill.id, invocation: { type: "slash", name: "review" } },
        { type: "text", text: " in [skill: house-style] before editing." },
      ],
    });
    const context = h.contexts[0];
    if (!context) throw new Error("No fake provider session");
    await context.onFrame(
      frames.frame({
        type: "item.upsert",
        agent: "root",
        item: "provider-echo",
        draft: {
          type: "message",
          role: "user",
          complete: true,
          parts: [
            {
              type: "text",
              // Claude echoes the native admission: the command, then the message as context.
              text: `/review\n\nMessage context:\n${block}\n\nPlease [review] in [skill: house-style] before editing.`,
            },
          ],
        },
      }),
    );
    await h.engine.flush();
    const reopened = new Store(h.path);
    const items = reopened.readItemPage(ThreadId.parse(id), reopened.headSeq() + 1, 20, 32768);
    await reopened.close();
    expect(
      items.items.filter(
        (i) =>
          i.type === "message" && i.role === "user" && i.parts.some((p) => p.type === "mention"),
      ),
    ).toMatchObject([{ parts: input }]);
  } finally {
    await library.close();
    await h.close();
  }
});
