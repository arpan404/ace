import { memoryKeyValue } from "@/test/harness.tsx";
import { expect, test } from "vitest";
import {
  keptMachineProjects,
  rememberMachineProjects,
  rememberMachinePush,
} from "./pool-projects.ts";

const project = (id: string) => ({ id, name: id, path: `/code/${id}` });

test("each machine's last list is kept for when it is offline", () => {
  const storage = memoryKeyValue();
  rememberMachineProjects(storage, "build", [project("api")], 10);
  rememberMachineProjects(storage, "studio", [project("web")], 20);
  expect(keptMachineProjects(storage, "build")).toEqual({ at: 10, projects: [project("api")] });
  expect(keptMachineProjects(storage, "studio")?.projects).toEqual([project("web")]);
});

test("one machine's list that no longer reads is dropped without losing the others", () => {
  const storage = memoryKeyValue();
  rememberMachineProjects(storage, "build", [project("api")], 10);
  const kept = JSON.parse(storage.getItem("ace.projects.lastSeen") ?? "{}");
  storage.setItem(
    "ace.projects.lastSeen",
    JSON.stringify({ ...kept, studio: { at: "yesterday", projects: "lots" } }),
  );
  expect(keptMachineProjects(storage, "studio")).toBeUndefined();
  expect(keptMachineProjects(storage, "build")?.projects).toEqual([project("api")]);
});

test("only the most recently seen machines are kept", () => {
  const storage = memoryKeyValue();
  for (let index = 0; index < 20; index++)
    rememberMachineProjects(storage, `machine-${index}`, [project("app")], index);
  expect(keptMachineProjects(storage, "machine-0")).toBeUndefined();
  expect(keptMachineProjects(storage, "machine-19")).toBeDefined();
});

test("a pushed change is kept on this device, so going offline never brings back the old key", () => {
  const storage = memoryKeyValue();
  const keyed = {
    ...project("ace"),
    remoteKey: { remotes: ["github.com/arpan/ace"], subpath: "" },
  };
  rememberMachineProjects(storage, "omarchy", [keyed, project("web")], 10);
  // Unlinked there: its daemon pushes it with no key. With no list held, the kept one changes.
  rememberMachinePush(storage, "omarchy", { put: project("ace") }, 20);
  expect(keptMachineProjects(storage, "omarchy")?.projects).toEqual([
    project("ace"),
    project("web"),
  ]);
  // With a list held, the held list is what's kept.
  rememberMachinePush(storage, "omarchy", { drop: "web" }, 30, [project("ace"), project("web")]);
  expect(keptMachineProjects(storage, "omarchy")).toEqual({ at: 30, projects: [project("ace")] });
});
