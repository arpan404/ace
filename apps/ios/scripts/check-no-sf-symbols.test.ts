import { expect, test } from "vitest";
import { disallowed, symbolUses } from "./check-no-sf-symbols.ts";

test("an image, label or button drawn from an SF Symbol is caught, each on its line", () => {
  const source = [
    'Image(systemName: "xmark")',
    'Label("Copy", systemImage: "doc.on.doc")',
    "Button(title, systemImage: symbol) { run() }",
    'UIImage(systemName: "at")',
  ].join("\n");
  expect(symbolUses("A.swift", source).map((use) => [use.line, use.use])).toEqual([
    [1, 'systemName: "xmark"'],
    [2, 'systemImage: "doc.on.doc"'],
    [3, "systemImage: symbol"],
    [4, 'systemName: "at"'],
  ]);
});

test("a symbol named in a comment or in words isn't a use", () => {
  const source = [
    '// Image(systemName: "folder") became AceIcon(.folder)',
    'Text("systemImage: is gone") // systemName: "x"',
    'AceIcon(.folder) // was systemImage: "folder"',
  ].join("\n");
  expect(symbolUses("A.swift", source)).toEqual([]);
});

test("only an allowed use in its own file passes", () => {
  const shortcut = 'shortTitle: "Open inbox", systemImageName: "tray")';
  const intents = "apps/ios/Sources/Intents/StartThreadIntent.swift";
  expect(disallowed(symbolUses(intents, shortcut))).toEqual([]);
  expect(disallowed(symbolUses("apps/ios/Sources/Views/Inbox.swift", shortcut))).toHaveLength(1);
});
