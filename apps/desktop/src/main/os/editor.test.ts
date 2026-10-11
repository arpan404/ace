import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openInEditor } from "./editor.ts";

const opened = vi.hoisted(() => ({ url: "" }));
vi.mock("electron", () => ({
  shell: {
    openExternal: async (url: string) => {
      opened.url = url;
    },
  },
}));

describe("native editor launches", () => {
  it.each(["vscode", "cursor", "zed"] as const)(
    "opens the exact %s file and position",
    async (editor) => {
      const folder = mkdtempSync(join(tmpdir(), "ace-editor-"));
      const path = join(folder, "naïve #?%.ts");
      try {
        writeFileSync(path, "");
        expect(await openInEditor({ editor, path, line: 12, column: 3 })).toBe(true);
        const url = new URL(opened.url);
        expect(decodeURIComponent(url.pathname)).toBe(`${path}:12:3`);
        expect(url.search + url.hash).toBe("");
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );
});
