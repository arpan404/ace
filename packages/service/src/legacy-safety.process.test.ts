import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

async function installation(home: string, version: string) {
  const root = join(home, ".ace-next");
  const target = `${process.platform}-${process.arch}`;
  const release = `releases/${version}-${target}`;
  await mkdir(join(root, release), { recursive: true });
  await mkdir(join(root, "bin"));
  await writeFile(
    join(root, "bin/ace"),
    version.startsWith("0.")
      ? "#!/bin/sh\nexit 99\n"
      : '#!/bin/sh\ntarget=$(readlink "$ACE_HOME/current")\nartifact="$ACE_HOME/$target"\nexec "$artifact/bin/node" "$artifact/ace.mjs" "$@"\n',
    { mode: 0o700 },
  );
  await writeFile(
    join(root, release, "release.json"),
    JSON.stringify({ version, target, channel: "stable" }),
  );
  await symlink(release, join(root, "current"));
  return root;
}
function command(home: string, root: string, action: string) {
  return promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { serviceCommand } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    console.log(JSON.stringify(await serviceCommand(${JSON.stringify(root)}, [${JSON.stringify(action)}])));
  `,
    ],
    { env: { ...process.env, HOME: home, PATH: join(home, "bin") } },
  );
}

test("release-shaped 0.x metadata cannot authorize execution of an installed service", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-legacy-manifest-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const root = await installation(home, "0.9.8");
  await expect(command(home, root, "start")).rejects.toThrow(
    /Incompatible or legacy ace installation/,
  );
  expect(await readFile(join(root, "bin/ace"), "utf8")).toBe("#!/bin/sh\nexit 99\n");
});

test("a compatible installation refuses a registered service that points at a legacy executable", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-legacy-plan-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const root = await installation(home, "1.2.3");
  const file =
    process.platform === "darwin"
      ? join(home, "Library/LaunchAgents/dev.ace.next.daemon.plist")
      : join(home, ".config/systemd/user/ace-next.service");
  await mkdir(join(file, ".."), { recursive: true });
  const legacy =
    process.platform === "darwin"
      ? `<key>ProgramArguments</key><array><string>${home}/.ace/bin/ace</string><string>service</string></array>`
      : `ExecStart=${home}/.ace/bin/ace service\n`;
  await writeFile(file, legacy);
  await expect(command(home, root, "start")).rejects.toThrow(/Incompatible or legacy ace service/);
  expect(await readFile(file, "utf8")).toBe(legacy);
});

test("a legacy executable cannot borrow a compatible release's metadata", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-legacy-hybrid-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const root = await installation(home, "1.2.3");
  await writeFile(
    join(root, "bin/ace"),
    `#!/bin/sh\necho executed > "${join(root, "executed")}"\nexit 99\n`,
  );
  await expect(command(home, root, "start")).rejects.toThrow(
    /Incompatible or legacy ace installation/,
  );
  await expect(readFile(join(root, "executed"))).rejects.toMatchObject({ code: "ENOENT" });
});
