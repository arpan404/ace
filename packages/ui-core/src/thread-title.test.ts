import { expect, test } from "vitest";
import { provisionalTitle } from "./thread-title.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];

test("a first message titles the thread by its first line of prose", () => {
  expect(
    provisionalTitle([
      { type: "file", path: "/private/image.png" },
      {
        type: "text",
        text: "\n # **Fix** @agent [file: image.png] the [login](https://example.com) redirect\nIgnore this line",
      },
    ]),
  ).toBe("Fix the login redirect");
});

test("a long first line ends at the last whole word within sixty characters", () => {
  const title = provisionalTitle(
    text(
      "Investigate reconnect failures while multiple desktop windows send simultaneous queued messages",
    ),
  );
  expect(title).toBe("Investigate reconnect failures while multiple desktop…");
  expect(title.length).toBeLessThanOrEqual(60);
});

test("a first line of exactly sixty characters is kept whole", () => {
  const line = "a".repeat(30) + " " + "b".repeat(29);
  expect(provisionalTitle(text(line))).toBe(line);
});

test("a message with only mentions and chips stays a New thread", () => {
  expect(provisionalTitle(text("@src/app.tsx [image: shot.png]"))).toBe("New thread");
  expect(provisionalTitle([{ type: "file", path: "/tmp/report.pdf" }])).toBe("New thread");
});

test("an email address in the prose is kept, a leading mention is not", () => {
  expect(provisionalTitle(text("@docs Reply to ops@example.com about the outage"))).toBe(
    "Reply to ops@example.com about the outage",
  );
});
