import { describe, expect, it } from "vitest";

import { resolveLocalStorageStoredValue } from "./useLocalStorage";

describe("resolveLocalStorageStoredValue", () => {
  it("uses the new key's fallback value instead of leaking the previous key's state", () => {
    expect(
      resolveLocalStorageStoredValue(
        {
          key: "thread-a",
          value: "diff",
        },
        "thread-b",
        "summary",
      ),
    ).toBe("summary");
  });

  it("keeps the stored value when the key matches", () => {
    expect(
      resolveLocalStorageStoredValue(
        {
          key: "thread-a",
          value: "diff",
        },
        "thread-a",
        "summary",
      ),
    ).toBe("diff");
  });
});
