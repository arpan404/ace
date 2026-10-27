import { ForgeCommit, ForgeFile, type ForgeFileContent } from "@ace/protocol";
import type { FixtureCommit, PullRequestFixture } from "./pull-request-details.ts";

/*
 * The code of the rich pull request (#245 in `acme/ace`) to review from the phone: four
 * commits (the save bar pushed to after the reviewer marked it viewed), a component with two
 * changes, a Markdown guide that reads better drawn, and a screenshot GitHub sends no patch
 * for. Each commit lists its own files; the guide and the screenshot read whole at the base
 * and at the commit that changed them.
 */

const minute = 60_000;
const iso = (at: number) => new Date(Math.max(0, at)).toISOString();
const saveBar = "apps/web/src/features/settings/save-bar.tsx";
const guide = "docs/settings.md";
const hero = "apps/web/public/settings-hero.png";

/** 240 × 135 PNG screenshots of the settings page, before and after. */
const heroBefore =
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAACHCAIAAACnEEO8AAABR0lEQVR42u3bsQ0AIAgAQQejckhK56NwCDewslBzyU1AvgNaRIdvNCNA0CBoEDQIGkGDoEHQIGgQNIIGQYOgQdAgaAQNgoYLgq6a8A1BI2gQNAgaBI2gQdAgaBA0CBpBg6Dh7aAzB+wJGkELGkELGkELGkEjaEEjaEEjaEEjaLD6BkGDoEHQCBoEDYIGQSNoEDT4KcTFhaARtKARtKAFLWgELWgELWgELWgELWhB2xSCoEHQIGgEDYIGQYOgQdAIGgQNbjlw+CFoBC1oBC1oQQsaQQsaQQsaQQsaQQta0DaFIGgQNII2BQQNggZBg6ARNAgaBA2CBkEjaBA0CBoEDYJG0CBoEDQIGgSNoEHQIGgQNAgaQYOgQdAgaBA0ggZBg6BB0CBoBA2CBkGDoBE0CBoEDYIGQSNoEDQIGgQNgkbQIGgQNBy2AFSBgVoW1htPAAAAAElFTkSuQmCC";
const heroAfter =
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAACHCAIAAACnEEO8AAABd0lEQVR42u3csQmAMBRF0YxjYZlpUjuEM6V0MguxCBZuIIoW5nPgTPC5VQgvDWOGMJITIGgQNAgaBI2gQdAgaBA0CBpBg6BB0CBoEDSCBkHDD4Je1w3CEDSCBkGDoEHQCBoEDYIGQYOgEfQ9pUxRCULQgkbQgkbQgkbQghY0CBoEDYIGQSNoEDR0F3StC1wTNIIWNIIWNIIWNIJG0IJG0N6hQdAIGgQNggZBg6ARNAgaBA2CRtCPBF5OsrokaAQtaEEjaEEjaEELGgQNggZBg6ARNAgaugva6ISpDUEjaEEjaEEjaEEjaAQtaATtHRoEjaBB0CBoEDQIGkGDoEHQIGgQNIIGQYOgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYJG0K6AoEHQIGj4KujWDvgnQSNoh0PQIGheyfMelaAFLWhBC1rQCFrQCFrQCFrQgha0oAUtaAQtaAQtaAQtaEELWtCCFjSCFjT4PgqCRtCCpsOgTx1AyQFdpTrfAAAAAElFTkSuQmCC";

const saveBarPatch = [
  "@@ -1,7 +1,10 @@",
  ' import { useState } from "react";',
  '+import { useKeyboardInset } from "../keyboard.ts";',
  " ",
  " export function SaveBar(props: { dirty: boolean; onSave(): void }) {",
  "-  const [saving, setSaving] = useState(false);",
  "+  const [saving, setSaving] = useState(false);",
  "+  const inset = useKeyboardInset();",
  '+  const label = saving ? "Saving…" : "Save changes";',
  "   return (",
  '-    <div className="save-bar">',
  '+    <div className="save-bar" style={{ bottom: inset }}>',
  "       <button disabled={!props.dirty || saving} onClick={() => {",
  "@@ -20,6 +23,7 @@ export function SaveBar(props: { dirty: boolean; onSave(): void }) {",
  "         setSaving(true);",
  "         props.onSave();",
  "       }}>",
  "-        Save",
  "+        {label}",
  "       </button>",
  '+      {props.dirty && <span className="save-bar-note">Unsaved changes</span>}',
  "     </div>",
].join("\n");

const guideBefore = [
  "# Settings",
  "",
  "Settings live on one page. Scroll to find the one you want.",
  "",
  "## Saving",
  "",
  "Press Save at the bottom of the page.",
  "",
].join("\n");
const guideAfter = [
  "# Settings",
  "",
  "Settings are grouped into sections: Account, Appearance and Notifications.",
  "",
  "## Saving",
  "",
  "The save bar stays in view while you scroll, and above the keyboard while you type.",
  "",
  "> [!TIP]",
  "> Unsaved changes are marked under the save bar.",
  "",
].join("\n");
const guidePatch = [
  "@@ -1,7 +1,10 @@",
  " # Settings",
  " ",
  "-Settings live on one page. Scroll to find the one you want.",
  "+Settings are grouped into sections: Account, Appearance and Notifications.",
  " ",
  " ## Saving",
  " ",
  "-Press Save at the bottom of the page.",
  "+The save bar stays in view while you scroll, and above the keyboard while you type.",
  "+",
  "+> [!TIP]",
  "+> Unsaved changes are marked under the save bar.",
].join("\n");

const changed = (
  path: string,
  additions: number,
  deletions: number,
  patch: string | null,
  status = "modified",
) => ForgeFile.parse({ path, status, additions, deletions, patch, truncated: false });

const text = (value: string): ForgeFileContent => ({
  kind: "text",
  text: value,
  size: value.length,
});
const image = (data: string): ForgeFileContent => ({
  kind: "image",
  type: "image/png",
  data,
  size: Math.floor((data.length * 3) / 4),
});

export function withCodeReview(fixture: PullRequestFixture, now: number): PullRequestFixture {
  const number = fixture.detail.status.ref.number;
  const head = fixture.detail.status.headSha;
  const base = fixture.detail.baseSha;
  const grouped = "c1".padEnd(40, "1");
  const kept = "c2".padEnd(40, "2");
  const described = "c3".padEnd(40, "3");
  const commit = (sha: string, message: string, ago: number, add: number, del: number) =>
    ForgeCommit.parse({
      sha,
      message,
      author: "you",
      additions: add,
      deletions: del,
      date: iso(now - ago * minute),
      url: `https://github.com/acme/ace/pull/${number}/commits/${sha}`,
    });
  const added = [
    changed(saveBar, 7, 3, saveBarPatch),
    changed(guide, 5, 2, guidePatch),
    changed(hero, 0, 0, null),
  ];
  const files = [...fixture.files, ...added];
  const commits: FixtureCommit[] = [
    {
      commit: commit(grouped, "Group the settings page into sections", 120, 178, 64),
      files: fixture.files,
    },
    {
      commit: commit(kept, "Keep the save bar in view", 90, 4, 2),
      files: [changed(saveBar, 4, 2, saveBarPatch.split("\n@@ -20")[0] ?? "")],
    },
    {
      commit: commit(described, "Describe the save bar in the settings guide", 60, 5, 2),
      files: [changed(guide, 5, 2, guidePatch), changed(hero, 0, 0, null)],
    },
    {
      commit: commit(head, "Say when there are unsaved changes", 13, 3, 1),
      files: [
        changed(
          saveBar,
          3,
          1,
          saveBarPatch.slice(saveBarPatch.indexOf("@@ -20")).replace("-20,6", "-23,6"),
        ),
      ],
    },
  ];
  return {
    ...fixture,
    detail: { ...fixture.detail, commits: commits.length, changedFiles: files.length },
    files,
    commits,
    contents: [
      {
        path: guide,
        versions: [
          { sha: base, content: text(guideBefore) },
          { sha: described, content: text(guideAfter) },
        ],
      },
      {
        path: hero,
        versions: [
          { sha: base, content: image(heroBefore) },
          { sha: described, content: image(heroAfter) },
        ],
      },
    ],
    review: {
      ...fixture.review,
      // The save bar was viewed before its last push; the guide since.
      viewed: files.map((file) => ({
        path: file.path,
        state: file.path === saveBar ? "DISMISSED" : file.path === guide ? "VIEWED" : "UNVIEWED",
      })),
    },
  };
}
