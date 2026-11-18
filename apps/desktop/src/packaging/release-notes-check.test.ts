import { describe, expect, it } from "vitest";
import { notesProblems, type NotesRules } from "./release-notes-check.ts";

const rules = (overrides: Partial<NotesRules> = {}): NotesRules => ({
  kind: "stable",
  prs: new Set([101, 102, 103]),
  limits: { bulletChars: 200, bullets: 12, totalChars: 3000 },
  bannedTerms: ["OpenAI", "Copilot", "AI-generated"],
  ...overrides,
});

const stable = `## New

- **Pull requests show what to do next.** Each open PR has one button. (#101)

## Improved

- **Search is faster.** Results appear as you type. (#102)

## Fixed

- **Images no longer get stuck.** They load after a reconnect. (#103)
`;

describe("release notes the pipeline accepts", () => {
  it("accepts stable notes with every section and every bullet citing a PR in the range", () => {
    expect(notesProblems(stable, rules())).toEqual([]);
  });

  it("accepts a section with no bullets", () => {
    const notes = stable.replace(
      "- **Search is faster.** Results appear as you type. (#102)\n",
      "",
    );
    expect(notesProblems(notes, rules())).toEqual([]);
  });

  it("requires Known issues on a beta, citing a PR in the range like every other bullet", () => {
    expect(notesProblems(stable, rules({ kind: "beta" }))).toEqual([
      "Missing sections: Known issues",
    ]);
    const known = (pr: number) =>
      `${stable}\n## Known issues\n\n- **Sign-in can loop once.** Restart to fix it. (#${pr})\n`;
    expect(notesProblems(known(101), rules({ kind: "beta" }))).toEqual([]);
    expect(notesProblems(known(90), rules({ kind: "beta" }))).toEqual([
      expect.stringMatching(/cites #90, not in this release$/),
    ]);
  });
});

describe("release notes the pipeline refuses", () => {
  it("refuses a bullet that cites no PR, or a PR outside the release", () => {
    const notes = stable.replace("(#102)", "").replace("(#103)", "(#7)");
    expect(notesProblems(notes, rules())).toEqual([
      '"**Search is faster.** Results appear as you type." cites no PR (#<number>)',
      expect.stringMatching(
        /^"\*\*Images no longer get stuck\.\*\*.*" cites #7, not in this release$/,
      ),
    ]);
  });

  it("refuses missing, unknown, repeated and out-of-order sections", () => {
    expect(notesProblems(stable.replace("## Fixed", "## Fixes"), rules())).toEqual([
      'Unknown section "Fixes" on line 9',
      "Missing sections: Fixed",
    ]);
    const swapped = stable
      .replace("## New", "## TMP")
      .replace("## Improved", "## New")
      .replace("## TMP", "## Improved");
    expect(notesProblems(swapped, rules())).toEqual([
      "Sections must come in this order: New, Improved, Fixed",
    ]);
    expect(notesProblems(`${stable}\n## New\n`, rules())).toContain('Section "New" appears twice');
  });

  it("refuses text the app would show as a line of its own", () => {
    expect(notesProblems(`Here are the notes.\n\n${stable}`, rules())).toEqual([
      'Line 1 is neither a "## " heading nor a "- " bullet',
    ]);
    expect(notesProblems(`${stable}\n---\n`, rules())).toHaveLength(1);
    expect(notesProblems(`- Early (#101)\n${stable}`, rules())).toEqual([
      "Line 1 comes before the first section",
    ]);
  });

  it.each([
    ["a bare URL", "See https://example.com/update for more."],
    ["a URL without a scheme", "Download it from www.example.com today."],
    ["a Markdown link", "Read [the guide](/docs/guide) first."],
    ["an autolink", "Mail <help@example.com> for help."],
    ["HTML", "Now <b>faster</b> than before."],
    ["an HTML comment", "Faster. <!-- hidden -->"],
  ])("refuses %s, which a PR body could have planted", (_kind, text) => {
    const notes = stable.replace("Results appear as you type.", text);
    expect(notesProblems(notes, rules())).toEqual([
      expect.stringMatching(/holds a link, URL or HTML; notes are plain text$/),
    ]);
  });

  it("refuses notes over the length limits", () => {
    const long = stable.replace("Each open PR has one button.", "x".repeat(220));
    expect(notesProblems(long, rules())[0]).toMatch(/characters; at most 200$/);
    expect(
      notesProblems(stable, rules({ limits: { bulletChars: 200, bullets: 2, totalChars: 3000 } })),
    ).toEqual(["3 bullets; at most 2"]);
    expect(
      notesProblems(
        stable,
        rules({ limits: { bulletChars: 200, bullets: 12, totalChars: 100 } }),
      )[0],
    ).toMatch(/characters; at most 100$/);
  });

  it("refuses notes with nothing new, improved or fixed", () => {
    expect(notesProblems("## New\n\n## Improved\n\n## Fixed\n", rules())).toEqual([
      "No bullet under New, Improved or Fixed",
    ]);
  });

  it("refuses a mention of another product or AI tool, as a whole word in any case", () => {
    const notes = stable.replace("Each open PR", "Like copilot, each open PR");
    expect(notesProblems(notes, rules())).toEqual(["Mentions Copilot"]);
    expect(notesProblems(stable.replace("faster", "AI-generated"), rules())).toEqual([
      "Mentions AI-generated",
    ]);
    expect(notesProblems(stable.replace("Search", "Copiloting"), rules())).toEqual([]);
  });
});
