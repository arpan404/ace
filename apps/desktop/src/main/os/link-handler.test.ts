import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { nodeAppImageEntryFiles } from "./appimage-entry.ts";
import { claimAceLinks, withAceLinkDefault } from "./link-handler.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("ace becomes the default for ace:// links in a mimeapps.list that names none", () => {
  expect(withAceLinkDefault(undefined)).toBe(
    "[Default Applications]\nx-scheme-handler/ace=dev.ace.app.desktop;\n",
  );
  expect(
    withAceLinkDefault(
      "[Added Associations]\ntext/plain=gedit.desktop;\n\n[Default Applications]\ntext/html=firefox.desktop;\n",
    ),
  ).toBe(
    "[Added Associations]\ntext/plain=gedit.desktop;\n\n[Default Applications]\nx-scheme-handler/ace=dev.ace.app.desktop;\ntext/html=firefox.desktop;\n",
  );
  expect(withAceLinkDefault("[Added Associations]\ntext/plain=gedit.desktop;\n")).toBe(
    "[Added Associations]\ntext/plain=gedit.desktop;\n\n[Default Applications]\nx-scheme-handler/ace=dev.ace.app.desktop;\n",
  );
});

test("a default an earlier ace launch set moves to the current entry; one the person chose stays", () => {
  expect(
    withAceLinkDefault("[Default Applications]\nx-scheme-handler/ace=ace-desktop.desktop;\n"),
  ).toBe("[Default Applications]\nx-scheme-handler/ace=dev.ace.app.desktop;\n");
  expect(
    withAceLinkDefault("[Default Applications]\nx-scheme-handler/ace=dev.ace.app.desktop;\n"),
  ).toBeUndefined();
  expect(
    withAceLinkDefault("[Default Applications]\nx-scheme-handler/ace=my-ace-build.desktop;\n"),
  ).toBeUndefined();
});

test("a launch writes the default into the person's config and leaves the rest of the file", () => {
  const root = mkdtempSync(join(tmpdir(), "ace-link-handler-"));
  roots.push(root);
  const config = join(root, "config");
  mkdirSync(config);
  writeFileSync(
    join(config, "mimeapps.list"),
    "[Default Applications]\ntext/html=firefox.desktop;\n",
  );
  const warnings: string[] = [];
  claimAceLinks({
    env: { XDG_CONFIG_HOME: config },
    home: join(root, "home"),
    files: nodeAppImageEntryFiles,
    warn: (message) => warnings.push(message),
  });
  expect(warnings).toEqual([]);
  expect(readFileSync(join(config, "mimeapps.list"), "utf8")).toBe(
    "[Default Applications]\nx-scheme-handler/ace=dev.ace.app.desktop;\ntext/html=firefox.desktop;\n",
  );
});
