import { expect, test } from "vitest";
import type { ProcFs } from "@ace/provider-kit/process-listing";
import { fakeMachine } from "@ace/provider-kit/process-tree-test-support";
import { serviceCgroupMembers } from "./owned-processes.ts";

const unit = "/user.slice/user-1000.slice/user@1000.service/app.slice/ace-next-0123456789.service";

/** The daemon (100) under a supervisor (90) started for `supervisorHome`, in `cgroups`. */
function service(options: {
  supervisorHome: string;
  cgroups: Record<number, string>;
  members?: number[];
}) {
  const { listing } = fakeMachine({
    90: { parent: 1, start: "supervisor", env: [`ACE_HOME=${options.supervisorHome}`] },
    100: { parent: 90, start: "daemon" },
  });
  const proc: ProcFs = {
    list: () => undefined,
    read(path) {
      const cgroup = /^\/proc\/(\d+)\/cgroup$/.exec(path);
      if (cgroup) {
        const value = options.cgroups[Number(cgroup[1])];
        return value === undefined ? undefined : Buffer.from(`0::${value}\n`);
      }
      if (path === `/sys/fs/cgroup${unit}/cgroup.procs`)
        return Buffer.from(`${(options.members ?? [90, 100, 300]).join("\n")}\n`);
      return undefined;
    },
  };
  return { listing: { ...listing, platform: "linux" as const }, proc };
}

test("the daemon sweeps its unit's cgroup only when the unit is this home's", () => {
  const sweep = (setup: ReturnType<typeof service>) =>
    serviceCgroupMembers({ ...setup, self: 100, home: "/homes/a" });
  // This home's unit: every process the service started.
  expect(sweep(service({ supervisorHome: "/homes/a", cgroups: { 90: unit, 100: unit } }))).toEqual([
    90, 100, 300,
  ]);
  // A daemon unit whose supervisor was started for another home: never this home's to sweep.
  expect(sweep(service({ supervisorHome: "/homes/b", cgroups: { 90: unit, 100: unit } }))).toEqual(
    [],
  );
  // The daemon's parent isn't in the unit: not the service's supervisor.
  expect(
    sweep(
      service({ supervisorHome: "/homes/a", cgroups: { 90: "/user.slice/term.scope", 100: unit } }),
    ),
  ).toEqual([]);
  // Not a daemon unit at all (a terminal's scope).
  expect(
    sweep(
      service({ supervisorHome: "/homes/a", cgroups: { 90: "/x/vte.scope", 100: "/x/vte.scope" } }),
    ),
  ).toEqual([]);
});
