import { afterEach, expect, it } from "vitest";
import { appArmorSetupScript } from "@ace/browser/linux-sandbox";
import type { DiagnosticReport } from "@ace/protocol";
import { recommendedRepairs } from "../doctor-plan.ts";
import { APPARMOR_REPAIR, PACKAGES_REPAIR, createLinuxFeature, type LinuxNeeds } from "./linux.ts";
import { doctorTestContext } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const report: DiagnosticReport = { at: 0, checks: [] };
const chrome = {
  name: "ace-chromium",
  // A custom ACE_HOME: the shared report would show it as a marker; the repair can't.
  text: "profile ace-chromium /srv/ace-sam/chromium/*/chrome-linux{64,-arm64}/chrome flags=(unconfined) {\n  userns,\n}\n",
};
const needs: LinuxNeeds = {
  packages: {
    libraries: ["libnss3.so"],
    steps: [
      ["apt-get", "update"],
      ["apt-get", "install", "-y", "libnss3"],
    ],
  },
  profiles: [chrome],
};

async function linuxContext() {
  const { context, cleanup } = await doctorTestContext({ platform: "linux" });
  cleanups.push(cleanup);
  return context;
}
function feature(found: LinuxNeeds, codes: number[] = [], parser = true) {
  const ran: string[][] = [];
  return {
    ran,
    feature: createLinuxFeature({
      needs: async () => found,
      runAsRoot: async (argv) => {
        ran.push(argv);
        return codes.shift() ?? 0;
      },
      root: false,
      hasParser: () => parser,
    }),
  };
}

it("dry run shows the exact commands, this machine's paths unredacted, and --fix would run both", async () => {
  const context = await linuxContext();
  const plan = (await feature(needs).feature.repairs?.(report, context)) ?? [];
  expect(plan.map((repair) => repair.id)).toEqual([PACKAGES_REPAIR, APPARMOR_REPAIR]);
  expect(plan[0]?.detail).toContain("\nsudo apt-get update\nsudo apt-get install -y libnss3");
  expect(plan[1]?.detail).toContain(`sudo tee /etc/apparmor.d/ace-chromium >/dev/null <<'EOF'\n`);
  expect(plan[1]?.detail).toContain("/srv/ace-sam/chromium/*/chrome-linux{64,-arm64}/chrome");
  expect(plan[1]?.detail).toContain("\nsudo apparmor_parser -r /etc/apparmor.d/ace-chromium");
  expect(recommendedRepairs(plan)).toEqual([PACKAGES_REPAIR, APPARMOR_REPAIR]);
});

it("nothing is offered off Linux or when the machine needs nothing", async () => {
  const { context, cleanup } = await doctorTestContext({ platform: "darwin" });
  cleanups.push(cleanup);
  expect(await feature(needs).feature.repairs?.(report, context)).toEqual([]);
  expect(await feature({ profiles: [] }).feature.repairs?.(report, await linuxContext())).toEqual(
    [],
  );
});

it("installs packages step by step as root and stops at the first step that fails", async () => {
  const context = await linuxContext();
  const ok = feature(needs);
  expect(await ok.feature.apply?.(PACKAGES_REPAIR, report, context)).toEqual([
    { id: PACKAGES_REPAIR, status: "fixed", message: "Installed the packages for libnss3.so." },
  ]);
  expect(ok.ran).toEqual(needs.packages?.steps);

  const offline = feature(needs, [100]);
  const [result] = (await offline.feature.apply?.(PACKAGES_REPAIR, report, context)) ?? [];
  expect(result).toMatchObject({
    status: "failed",
    message: "sudo apt-get update exited with 100.",
  });
  expect(offline.ran).toHaveLength(1);
});

it("installs every profile through the checked root script and reports a refused one", async () => {
  const context = await linuxContext();
  const cursor = { name: "ace-cursor-sandbox", text: "profile ace-cursor-sandbox /x {\n}\n" };
  const both = feature({ profiles: [chrome, cursor] });
  expect(await both.feature.apply?.(APPARMOR_REPAIR, report, context)).toEqual([
    {
      id: APPARMOR_REPAIR,
      status: "fixed",
      message: "Installed and loaded ace-chromium, ace-cursor-sandbox.",
    },
  ]);
  expect(both.ran).toEqual([
    [
      "/bin/sh",
      "-c",
      appArmorSetupScript,
      "ace-sandbox-setup",
      chrome.name,
      chrome.text,
      cursor.name,
      cursor.text,
    ],
  ]);
  const refused = feature({ profiles: [chrome] }, [65]);
  expect(await refused.feature.apply?.(APPARMOR_REPAIR, report, context)).toEqual([
    {
      id: APPARMOR_REPAIR,
      status: "failed",
      message: "AppArmor refused ace-chromium; nothing was written.",
    },
  ]);
});

it("a repair whose need went away is skipped without running anything", async () => {
  const context = await linuxContext();
  const done = feature({ profiles: [] });
  const results = [
    ...((await done.feature.apply?.(PACKAGES_REPAIR, report, context)) ?? []),
    ...((await done.feature.apply?.(APPARMOR_REPAIR, report, context)) ?? []),
  ];
  expect(results.map((result) => result.status)).toEqual(["skipped", "skipped"]);
  expect(done.ran).toEqual([]);
});

it("without AppArmor's parser (a container) the profile is listed but blocked, so --fix skips it", async () => {
  const context = await linuxContext();
  const plan = (await feature(needs, [], false).feature.repairs?.(report, context)) ?? [];
  expect(plan.find((repair) => repair.id === APPARMOR_REPAIR)?.blocked).toMatch(
    /apparmor_parser isn't installed/,
  );
  expect(recommendedRepairs(plan)).toEqual([PACKAGES_REPAIR]);
});
