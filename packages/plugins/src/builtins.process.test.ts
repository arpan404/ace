import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "vitest";
import { prepareBuiltinSkills } from "./index.ts";

test.each(["claude", "codex"] as const)(
  "%s discovers the shipped visualize skill in an isolated native plugin",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "ace-builtins-"));
    try {
      const session = await prepareBuiltinSkills(provider, root);
      const skill = await readFile(
        join(root, "generated/plugins/ace-builtins/skills/visualize/SKILL.md"),
        "utf8",
      );
      expect(skill).toContain("invalid_html");
      expect(skill).toContain("ace_html_render");
      if (provider === "claude")
        expect(session.directories).toEqual([join(root, "generated/plugins/ace-builtins")]);
      else {
        expect(session.args.join(" ")).toContain("marketplaces.ace.source");
        expect(session.args.join(" ")).toContain("ace-builtins@ace");
        const marketplace = await readFile(
          join(root, "generated/.agents/plugins/marketplace.json"),
          "utf8",
        );
        expect(marketplace).toContain("ace-builtins");
      }
      await session.close();
      await expect(
        readFile(join(root, "generated/plugins/ace-builtins/skills/visualize/SKILL.md")),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
