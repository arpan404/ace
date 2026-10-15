import { expect, it } from "vitest";
import { reapProfileGroups, type ProcessEntry } from "./guardian-cleanup.ts";

const live: ProcessEntry = {
  pid: 100,
  group: 50,
  state: "S",
  command: "chromium --user-data-dir=/p --foo",
};

function refuse(code: string) {
  return async (): Promise<void> => {
    throw Object.assign(new Error(`kill ${code}`), { code });
  };
}

it("a profile group that only has zombies left when signalled is cleaned up", async () => {
  let inventories = 0;
  const processes = async (): Promise<ProcessEntry[]> => {
    inventories += 1;
    return inventories <= 2 ? [live] : [{ ...live, state: "Z" }];
  };
  await expect(
    reapProfileGroups({ profile: "/p", self: 9999, processes, kill: refuse("EPERM") }),
  ).resolves.toBeUndefined();
});

it("a group that refuses the signal and stays alive still fails cleanup", async () => {
  await expect(
    reapProfileGroups({
      profile: "/p",
      self: 9999,
      processes: async () => [live],
      kill: refuse("EPERM"),
    }),
  ).rejects.toThrow("Chromium process group did not exit");
});

it("other signal failures still fail cleanup", async () => {
  await expect(
    reapProfileGroups({
      profile: "/p",
      self: 9999,
      processes: async () => [live],
      kill: refuse("EINVAL"),
    }),
  ).rejects.toThrow("kill EINVAL");
});

it("processes of other profiles are never signalled", async () => {
  const signalled: number[] = [];
  await reapProfileGroups({
    profile: "/p",
    self: 9999,
    processes: async () => [{ ...live, command: "chromium --user-data-dir=/other --foo" }],
    kill: async (group) => {
      signalled.push(group);
    },
  });
  expect(signalled).toEqual([]);
});
