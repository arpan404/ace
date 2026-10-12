import { describe, expect, it } from "vitest";
import { editorUrl, launchEditor } from "./editor-launch.ts";

describe("editor launches", () => {
  it.each(["code", "cursor", "zed"])(
    "opens the exact %s path and line despite filename delimiters",
    (editorId) => {
      const url = new URL(
        editorUrl({ editorId, editorName: editorId, path: "/tmp/naïve #?%/file?.ts", line: 12 }) ??
          "",
      );
      expect(decodeURIComponent(url.pathname)).toBe("/tmp/naïve #?%/file?.ts:12");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    },
  );
  it("passes an encoded file URI to Sublime", () => {
    const url = new URL(
      editorUrl({ editorId: "subl", editorName: "Sublime", path: "/tmp/a#b?.ts", line: 12 }) ?? "",
    );
    const file = new URL(url.searchParams.get("url") ?? "");
    expect(decodeURIComponent(file.pathname)).toBe("/tmp/a#b?.ts");
    expect(file.hash + file.search).toBe("");
    expect(url.searchParams.get("line")).toBe("12");
  });
  it("sends the original filesystem path through the desktop bridge", async () => {
    let received: unknown;
    await launchEditor(
      { editorId: "code", editorName: "VS Code", path: "/tmp/a#b?.ts", line: 12 },
      {
        ace: {
          shell: {
            openInEditor: (request: unknown) => {
              received = request;
              return true;
            },
          },
        },
      },
    );
    expect(received).toEqual({ editor: "vscode", path: "/tmp/a#b?.ts", line: 12 });
  });
});
