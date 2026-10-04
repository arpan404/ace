import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { planService, UserService, type Runner } from "./index.ts";

for (const platform of ["linux", "darwin"] as const)
  for (const action of ["status", "start", "stop", "uninstall", "install"] as const)
    for (const registration of ["missing", "compatible"] as const)
      test(`${platform} ${action} refuses a loaded legacy service with ${registration} registration`, async ({
        onTestFinished,
      }) => {
        const home = await mkdtemp(join(tmpdir(), "ace-loaded-legacy-"));
        onTestFinished(() => rm(home, { recursive: true, force: true }));
        const plan = planService({
          platform,
          home,
          dataDir: join(home, ".ace-next"),
          executable: join(home, ".ace-next/bin/ace"),
          path: "/bin",
          uid: 501,
        });
        if (registration === "compatible") {
          await mkdir(dirname(plan.file), { recursive: true });
          await writeFile(plan.file, plan.content);
        }
        const effects = join(home, "manager-effects");
        const run: Runner = async (_file, args) => {
          const query =
            args.includes("is-active") || args.includes("print") || args.includes("show");
          if (!query) await writeFile(effects, args.join(" "));
          return {
            code: 0,
            stderr: "",
            stdout:
              platform === "darwin"
                ? `\tpath = ${plan.file}\n\tprogram = ${home}/.ace/bin/ace\n\targuments = {\n\t\t${home}/.ace/bin/ace\n\t\tservice\n\t}\n`
                : `LoadState=loaded\nActiveState=active\nFragmentPath=${plan.file}\nExecStart={ path=${home}/.ace/bin/ace ; argv[]=${home}/.ace/bin/ace service ; ignore_errors=no ; }\nExecCondition=\nExecStartPre=\nExecStartPost=\nExecReload=\nExecStop=\nExecStopPost=\nDropInPaths=\n`,
          };
        };
        await expect(new UserService(plan, run).perform(action)).rejects.toThrow(
          /Incompatible or legacy ace service/,
        );
        await expect(readFile(effects)).rejects.toMatchObject({ code: "ENOENT" });
        if (registration === "compatible")
          expect(await readFile(plan.file, "utf8")).toBe(plan.content);
      });

for (const platform of ["linux", "darwin"] as const)
  test(`${platform} registration refuses an additional legacy execution hook before manager contact`, async ({
    onTestFinished,
  }) => {
    const home = await mkdtemp(join(tmpdir(), "ace-extra-hook-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const plan = planService({
      platform,
      home,
      dataDir: join(home, ".ace-next"),
      executable: join(home, ".ace-next/bin/ace"),
      path: "/bin",
      uid: 501,
    });
    await mkdir(dirname(plan.file), { recursive: true });
    const content =
      platform === "linux"
        ? plan.content.replace(
            "[Service]\n",
            `[Service]\nExecCondition=\nExecStartPre=${home}/.ace/bin/ace service\n`,
          )
        : plan.content.replace(
            "<key>RunAtLoad</key>",
            `<key>Program</key><string>${home}/.ace/bin/ace</string><key>RunAtLoad</key>`,
          );
    await writeFile(plan.file, content);
    const contact = join(home, "manager-contact");
    const run: Runner = async () => {
      await writeFile(contact, "contacted");
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(new UserService(plan, run).perform("start")).rejects.toThrow(
      /Incompatible or legacy ace service/,
    );
    await expect(readFile(contact)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(plan.file, "utf8")).toBe(content);
  });

for (const action of ["install", "start", "stop", "status", "uninstall"] as const)
  test(`the public service ${action} refuses legacy binary metadata even without optional preflight`, async ({
    onTestFinished,
  }) => {
    const home = await mkdtemp(join(tmpdir(), "ace-mandatory-service-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const root = join(home, ".ace");
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin/ace"), "legacy executable");
    const plan = planService({
      platform: "linux",
      home,
      dataDir: root,
      executable: join(root, "bin/ace"),
      path: "/bin",
      uid: 501,
    });
    const contact = join(home, "manager-contact");
    const run: Runner = async () => {
      await writeFile(contact, "contacted");
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(new UserService(plan, run).perform(action)).rejects.toThrow(
      /Incompatible or legacy/,
    );
    await expect(readFile(contact)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "bin/ace"), "utf8")).toBe("legacy executable");
  });

for (const hook of [
  "ExecCondition",
  "ExecStartPre",
  "ExecStartPost",
  "ExecReload",
  "ExecStop",
  "ExecStopPost",
  "DropInPaths",
])
  test(`a compatible file cannot authorize a manager-loaded legacy ${hook}`, async ({
    onTestFinished,
  }) => {
    const home = await mkdtemp(join(tmpdir(), "ace-loaded-hook-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const plan = planService({
      platform: "linux",
      home,
      dataDir: join(home, ".ace-next"),
      executable: join(home, ".ace-next/bin/ace"),
      path: "/bin",
      uid: 501,
    });
    await mkdir(dirname(plan.file), { recursive: true });
    await writeFile(plan.file, plan.content);
    const effects = join(home, "manager-effects");
    const run: Runner = async (_file, args) => {
      if (!args.includes("show")) await writeFile(effects, args.join(" "));
      const hooks = [
        "ExecCondition",
        "ExecStartPre",
        "ExecStartPost",
        "ExecReload",
        "ExecStop",
        "ExecStopPost",
        "DropInPaths",
      ]
        .map((key) => `${key}=${key === hook ? home + "/.ace/bin/ace service" : ""}`)
        .join("\n");
      return {
        code: 0,
        stderr: "",
        stdout: `LoadState=loaded\nActiveState=inactive\nFragmentPath=${plan.file}\nExecStart={ path=${plan.command[0]} ; argv[]=${plan.command.join(" ")} ; ignore_errors=no ; }\n${hooks}\n`,
      };
    };
    await expect(new UserService(plan, run).perform("start")).rejects.toThrow(
      /Incompatible or legacy ace service/,
    );
    await expect(readFile(effects)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(plan.file, "utf8")).toBe(plan.content);
  });
