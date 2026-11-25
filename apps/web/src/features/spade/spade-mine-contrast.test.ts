import { contrastRatio, parseOpaqueColor, themeIds } from "@ace/themes";
import { renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { themeDeclarations } from "@/theme/css.ts";
import { useMineAccent } from "./spade-accent.ts";

const rgb = (value: string | undefined) => {
  const parsed = parseOpaqueColor(value);
  if (!parsed) throw new Error(`not an opaque colour: ${value}`);
  return parsed;
};

test("a white-faced bot's pill keeps the theme's person colour, and its text and in-pill cards read at AA in light mode", () => {
  // Spade's own face is monochrome: it has no accent, so the conversation keeps the theme's
  // pill instead of deriving a colour (or a near-black one) from the face.
  const { result } = renderHook(() => useMineAccent({ avatar: { kind: "spade" } }));
  expect(result.current).toBeUndefined();
  for (const id of themeIds) {
    const tokens = themeDeclarations(id, "light");
    const pill = tokens["--chat-mine"];
    // The words, the meta line, and the attachment card's wash (what a card inside the pill is
    // drawn on) are each readable on the pill.
    for (const ink of ["--chat-mine-foreground", "--chat-mine-meta"])
      expect([id, ink, contrastRatio(rgb(tokens[ink]), rgb(pill))]).toEqual([
        id,
        ink,
        expect.toSatisfy((ratio: number) => ratio >= 4.5),
      ]);
    expect([
      id,
      contrastRatio(rgb(tokens["--chat-mine-foreground"]), rgb(tokens["--chat-mine-code"])),
    ]).toEqual([id, expect.toSatisfy((ratio: number) => ratio >= 4.5)]);
  }
});
