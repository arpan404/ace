import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { emojiFile, splitEmoji } from "@/lib/emoji.ts";
import { Emoji, WithEmoji } from "./emoji.tsx";

test("an emoji is found by its codepoints, a variation selector kept only inside a sequence", () => {
  expect(emojiFile("👍")).toBe("1f44d");
  expect(emojiFile("❤️")).toBe("2764");
  expect(emojiFile("❤️‍🔥")).toBe("2764-fe0f-200d-1f525");
  expect(emojiFile("🇳🇵")).toBe("1f1f3-1f1f5");
});

test("words split into text and emoji, and digits and # stay text", () => {
  expect(splitEmoji("Ship it 🚀 now 1 #2 👨‍👩‍👧!")).toEqual([
    { kind: "text", text: "Ship it " },
    { kind: "emoji", text: "🚀" },
    { kind: "text", text: " now 1 #2 " },
    { kind: "emoji", text: "👨‍👩‍👧" },
    { kind: "text", text: "!" },
  ]);
});

test("a picker emoji draws as an image at once, with its character as the alt text", () => {
  render(<Emoji emoji="👍" />);
  const image = screen.getByRole("img", { name: "👍" });
  expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml|\.svg/);
  expect(image.getAttribute("draggable")).toBe("false");
});

test("any other emoji loads its image from the bundle, and one with none stays the system glyph", async () => {
  render(
    <p>
      <WithEmoji text="Party 🎉 and 🇦🇦" />
    </p>,
  );
  expect(await screen.findByRole("img", { name: "🎉" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "🇦🇦" })).toBeNull();
  expect(screen.getByText("🇦🇦")).toBeTruthy();
});
