import { describe, expect, test } from "vitest";
import {
  spadeHoldPhrase,
  spadePhraseChars,
  spadePlainPhrase,
  spadeWorkingPhrase,
} from "./working-phrase.ts";

describe("the Spade Working line's words", () => {
  test.each([
    // The model's own headline and plan step, as Spade sends them.
    ["Comparing flight prices", "Comparing flight prices"],
    ["**Analyzing the test failures**", "Analyzing the test failures"],
    ["Compare hotel prices", "Compare hotel prices"],
    // Tool phrases.
    ["Searching the web for flights", "Searching the web for flights"],
    ["Running the tests", "Running the tests"],
    ["Waiting on 3 ace agents", "Waiting on 3 ace agents"],
    ["Using an app on the screen", "Using an app on the screen"],
    // Nothing of its own to say: "Working", never "Thinking" alone, a command or a tool id.
    [undefined, "Working"],
    ["", "Working"],
    ["Thinking", "Working"],
    ["Running command", "Working"],
    ["Running a command", "Working"],
    ["Using frobnicate widgets", "Working"],
    ["Using a tool", "Working"],
  ])("%j reads %j", (status, line) => {
    expect(spadeWorkingPhrase(status)).toBe(line);
  });

  test("a long headline is cut to a few words and never ends on a dangling word", () => {
    expect(spadePlainPhrase("Checking the forecast for Oxford and London today")).toBe(
      "Checking the forecast for Oxford",
    );
    const long = spadePlainPhrase("Supercalifragilisticexpialidocious ".repeat(6)) ?? "";
    expect(long.length).toBeLessThanOrEqual(spadePhraseChars);
  });

  test("a phrase is plain text: markup and control characters are gone", () => {
    expect(spadeWorkingPhrase("> Reading\u0007 `auth.ts`\n# now")).toBe("Reading auth.ts now");
    expect(spadePlainPhrase("**  **")).toBeUndefined();
  });
});

describe("holding a phrase", () => {
  test("a new phrase waits until the one shown has been up for the hold", () => {
    const first = spadeHoldPhrase(undefined, "Reading the brief", 0);
    expect(first.held.text).toBe("Reading the brief");
    const early = spadeHoldPhrase(first.held, "Searching the web", 500);
    expect(early.held.text).toBe("Reading the brief");
    expect(early.recheckIn).toBe(700);
    const later = spadeHoldPhrase(early.held, "Searching the web", 1200);
    expect(later.held).toEqual({ text: "Searching the web", since: 1200 });
    expect(later.recheckIn).toBeUndefined();
  });

  test("the same phrase again keeps its time", () => {
    const shown = { text: "Running the tests", since: 100 };
    expect(spadeHoldPhrase(shown, "Running the tests", 5000).held).toBe(shown);
  });
});
