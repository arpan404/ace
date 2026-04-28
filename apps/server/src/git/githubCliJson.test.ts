import { describe, expect, it } from "vitest";

import { parseJsonFromCliOutput } from "./githubCliJson.ts";

describe("parseJsonFromCliOutput", () => {
  it("parses clean JSON output", () => {
    expect(parseJsonFromCliOutput('[{"number":42}]')).toEqual([{ number: 42 }]);
  });

  it("extracts a JSON payload from surrounding CLI noise", () => {
    expect(
      parseJsonFromCliOutput(
        'warning: experimental output\n[{"number":42,"title":"Test"}]\nextra trailing line\n',
      ),
    ).toEqual([{ number: 42, title: "Test" }]);
  });

  it("handles braces inside JSON strings", () => {
    expect(
      parseJsonFromCliOutput(
        'notice\n[{"message":"keeps {json}-like text inside strings","number":42}]\n',
      ),
    ).toEqual([{ message: "keeps {json}-like text inside strings", number: 42 }]);
  });
});
