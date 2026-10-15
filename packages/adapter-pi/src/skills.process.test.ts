import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { sessionHarness } from "./testing/harness.ts";

test("Pi discovers ace's shipped skills at session start", async () => {
  const skills = await mkdtemp(join(tmpdir(), "ace-pi-skills-"));
  for (const name of ["ace-browser", "ace-agents"]) {
    await mkdir(join(skills, name));
    await writeFile(
      join(skills, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\nBody.\n`,
    );
  }
  const h = await sessionHarness({}, false, {}, undefined, undefined, [], {
    args: [],
    directories: [skills],
  });
  try {
    // The fake lists what Pi would advertise from its `--skill` directories.
    await h.session.send([{ type: "text", text: "skills-proof" }], "queue");
    const listed = JSON.stringify(
      (
        await h.wait(
          (frame) => frame.dir === "recv" && JSON.stringify(frame.data).includes("ace-browser"),
        )
      ).data,
    );
    expect(listed).toContain("ace-browser");
    expect(listed).toContain("ace-agents");
  } finally {
    await h.dispose();
    await rm(skills, { recursive: true, force: true });
  }
});
