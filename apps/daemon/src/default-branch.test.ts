import { expect, test } from "vitest";
import { DefaultBranches } from "./default-branch.ts";

function sources(remote: string | undefined, forge: string | undefined) {
  const asked = { remote: 0, forge: 0 };
  return {
    asked,
    value: {
      remote: async () => {
        asked.remote++;
        return remote;
      },
      forge: async () => {
        asked.forge++;
        return forge;
      },
      local: async () => "main",
    },
  };
}

test("the remote's HEAD wins over the forge and the local guess", async () => {
  const branches = new DefaultBranches(() => 0);
  expect(await branches.resolve("repo", sources("trunk", "develop").value)).toBe("trunk");
});

test("an unreachable remote falls back to the forge's default branch", async () => {
  const branches = new DefaultBranches(() => 0);
  expect(await branches.resolve("repo", sources(undefined, "develop").value)).toBe("develop");
});

test("with no remote or forge answer the local guess is used", async () => {
  const branches = new DefaultBranches(() => 0);
  expect(await branches.resolve("repo", sources(undefined, undefined).value)).toBe("main");
});

test("an offline remote is asked once per window, not on every read", async () => {
  let clock = 0;
  const branches = new DefaultBranches(() => clock, 1_000);
  const offline = sources(undefined, undefined);
  await branches.resolve("repo", offline.value);
  await branches.resolve("repo", offline.value);
  expect(offline.asked).toEqual({ remote: 1, forge: 1 });
  clock += 1_000;
  const online = sources("trunk", undefined);
  expect(await branches.resolve("repo", online.value)).toBe("trunk");
});
