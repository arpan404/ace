import { expect, test } from "vitest";
import { accountMachineLine, accountMachineLists } from "./account-machines.ts";

const studio = "S".repeat(52);
const laptop = "L".repeat(52);
const now = 1_900_000_000_000;

test("a machine both paired and on the account lists once, as the paired machine", () => {
  const lists = accountMachineLists(
    [{ id: "primary-host" }, { id: studio }],
    [
      { hostId: studio, name: "Studio", platform: "darwin", lastSeenAt: now },
      { hostId: laptop, name: "Laptop", platform: "linux", lastSeenAt: now },
    ],
  );
  expect(lists.only.map((machine) => machine.name)).toEqual(["Laptop"]);
  expect([...lists.alsoOnAccount]).toEqual([studio]);
});

test("this computer's own daemon on the account isn't listed a second time", () => {
  const lists = accountMachineLists(
    [{ id: studio }],
    [{ hostId: studio, name: "This Mac", platform: "darwin", lastSeenAt: now }],
  );
  expect(lists.only).toEqual([]);
});

test("a machine the account reports twice lists once, and an unnamed one still has a name", () => {
  const lists = accountMachineLists(
    [],
    [
      { hostId: laptop, name: "  ", platform: "linux", lastSeenAt: now },
      { hostId: laptop, name: "Laptop again", platform: "linux", lastSeenAt: now },
    ],
  );
  expect(lists.only.map((machine) => machine.name)).toEqual(["Unnamed machine"]);
});

test("an account machine's row names its platform and when it was last seen", () => {
  const seen = { hostId: laptop, name: "Laptop", lastSeenAt: now - 3 * 3_600_000 };
  expect(accountMachineLine({ ...seen, platform: "darwin" }, now)).toBe("macOS · Seen 3h ago");
  expect(accountMachineLine({ ...seen, platform: "win32" }, now)).toBe("Windows · Seen 3h ago");
  expect(accountMachineLine({ ...seen, platform: "plan9" }, now)).toBe("plan9 · Seen 3h ago");
  expect(accountMachineLine({ ...seen, platform: "", lastSeenAt: 0 }, now)).toBe("Not seen yet");
});
