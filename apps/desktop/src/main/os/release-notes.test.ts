import { expect, it } from "vitest";
import { releaseNoteGroups, releaseNoteItems, releaseNoteLimits } from "./release-notes.ts";

/** GitHub's feed renders generated notes to HTML like this. */
const generated = (lines: string[]) =>
  [
    "<h2>What's Changed</h2>",
    "<ul>",
    ...lines.map((line) => `<li>${line}</li>`),
    "</ul>",
    "<h2>New Contributors</h2>",
    '<ul><li>@ada made their first contribution in <a href="https://github.com/arpan404/ace/pull/9">#9</a></li></ul>',
    '<p><strong>Full Changelog</strong>: <a href="https://github.com/arpan404/ace/compare/v1.0.0...v1.1.0">v1.0.0...v1.1.0</a></p>',
  ].join("\n");

it("generated notes read as short lines that point at their pull requests", () => {
  const note = generated([
    "Persist views across restarts by @arpan404 in https://github.com/arpan404/ace/pull/985",
    "Bump zod by @dependabot[bot] in https://github.com/arpan404/ace/pull/986",
    "Keep &lt;Tab&gt; focus &amp; selection by @arpan404 in https://github.com/arpan404/ace/pull/987",
  ]);
  expect(releaseNoteItems(note)).toEqual({
    items: [
      "Persist views across restarts (#985)",
      "Bump zod (#986)",
      "Keep <Tab> focus & selection (#987)",
    ],
    total: 3,
  });
});

it("hand-written markdown notes keep their lines without headings or link syntax", () => {
  const note =
    "## Highlights\n\n- **Updates** now show [what changed](https://ace.dev)\n- Faster startup";
  expect(releaseNoteItems(note).items).toEqual(["Updates now show what changed", "Faster startup"]);
});

it("a long release shows its first lines and counts the rest", () => {
  const note = Array.from({ length: 12 }, (_, index) => `- Change ${index + 1}`).join("\n");
  const { items, total } = releaseNoteItems(note);
  expect(items).toHaveLength(releaseNoteLimits.items);
  expect(items[0]).toBe("Change 1");
  expect(total).toBe(12);
  expect(releaseNoteItems(`- ${"x".repeat(400)}`).items[0]?.length).toBe(releaseNoteLimits.length);
});

it("every release since this version shows, newest first, without previews on stable", () => {
  const raw = [
    { version: "1.1.0", note: "<ul><li>Older change</li></ul>" },
    { version: "1.3.0-preview.1", note: "<ul><li>Preview change</li></ul>" },
    { version: "1.2.0", note: "<ul><li>Newer change</li></ul>" },
    { version: "1.0.0", note: "<ul><li>This version</li></ul>" },
    { version: "1.1.5", note: "<p></p>" },
  ];
  expect(releaseNoteGroups(raw, "1.2.0", "1.0.0")).toEqual({
    notes: [
      { version: "1.2.0", items: ["Newer change"], total: 1 },
      { version: "1.1.0", items: ["Older change"], total: 1 },
    ],
    olderReleases: 0,
  });
  expect(releaseNoteGroups(raw, "1.3.0-preview.1", "1.2.0-preview.1").notes[0]?.version).toBe(
    "1.3.0-preview.1",
  );
});

it("a single release's notes, or none, come through as they are", () => {
  expect(releaseNoteGroups("<ul><li>Only change</li></ul>", "1.1.0", "1.0.0").notes).toEqual([
    { version: "1.1.0", items: ["Only change"], total: 1 },
  ]);
  expect(releaseNoteGroups(null, "1.1.0", "1.0.0")).toEqual({ notes: [], olderReleases: 0 });
});

it("past the release limit, older releases are counted rather than listed", () => {
  const raw = Array.from({ length: 9 }, (_, index) => ({
    version: `1.${index + 1}.0`,
    note: "- A change",
  }));
  const { notes, olderReleases } = releaseNoteGroups(raw, "1.9.0", "1.0.0");
  expect(notes.map((note) => note.version)).toEqual([
    "1.9.0",
    "1.8.0",
    "1.7.0",
    "1.6.0",
    "1.5.0",
    "1.4.0",
  ]);
  expect(olderReleases).toBe(3);
});
