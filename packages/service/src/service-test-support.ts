import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { unquote, unxml } from "./plan.ts";
import type { Runner } from "./process.ts";
import { installSpadeBinary } from "./spade-release.ts";

/** Test support for the per-home service tests (ADR 0185): a temp machine and its manager. */

/** A person's folder with the default home `.ace` and a dev home beside it. */
export async function machine(onTestFinished: (fn: () => Promise<void>) => void) {
  const user = await mkdtemp(join(tmpdir(), "ace-service-per-home-"));
  onTestFinished(() => rm(user, { recursive: true, force: true }));
  const main = join(user, ".ace");
  const dev = join(user, "dev-home");
  await mkdir(main);
  await mkdir(dev);
  return { user, main, dev };
}

export async function withSpadeBinary(home: string) {
  const source = join(dirname(home), `spade-${basename(home)}`);
  await writeFile(source, "#!/bin/sh\n", { mode: 0o755 });
  await installSpadeBinary(home, source, "0.4.0");
}

/** The program a registration runs, as launchd or systemd would load it from the file. */
function loadedCommand(file: string): string[] {
  const content = readFileSync(file, "utf8");
  if (file.endsWith(".plist"))
    return [
      ...(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(content)?.[1] ?? "").matchAll(
        /<string>([^<]*)<\/string>/g,
      ),
    ].map((match) => unxml(match[1] ?? ""));
  // systemd reads the quoted word, its `%` specifiers and `$$` back to the program's path.
  const start = /^ExecStart="((?:[^"\\]|\\.)*)"(.*)$/m.exec(content);
  return [
    unquote(start?.[1] ?? "").replaceAll("$$", "$"),
    ...(start?.[2] ?? "").split(" ").filter(Boolean),
  ];
}

/**
 * One user's launchd or systemd holding any number of services, each loaded from its file
 * under `user`. Every change is recorded with the service it touched.
 */
export function serviceManager(user: string) {
  const loaded = new Set<string>();
  const running = new Set<string>();
  const changes: string[] = [];
  const fileOf = (name: string) =>
    name.startsWith("gui/")
      ? join(user, "Library/LaunchAgents", `${name.slice(name.lastIndexOf("/") + 1)}.plist`)
      : join(user, ".config/systemd/user", name);
  const run: Runner = async (file, args) => {
    const [verb, name = ""] = file === "systemctl" ? args.slice(1) : args;
    if (verb === "show" || verb === "print") {
      if (!loaded.has(name))
        return file === "launchctl"
          ? { code: 113, stdout: "", stderr: "" }
          : { code: 0, stdout: "LoadState=not-found\nActiveState=inactive\n", stderr: "" };
      const command = loadedCommand(fileOf(name));
      const stdout =
        file === "launchctl"
          ? `\tpath = ${fileOf(name)}\n\tstate = ${running.has(name) ? "running" : "waiting"}\n\tprogram = ${command[0]}\n\targuments = {\n${command.map((arg) => `\t\t${arg}\n`).join("")}\t}\n`
          : `LoadState=loaded\nActiveState=${running.has(name) ? "active" : "inactive"}\nFragmentPath=${fileOf(name)}\nExecStart={ path=${command[0]} ; argv[]=${command.join(" ")} ; ignore_errors=no ; }\n`;
      return { code: 0, stdout, stderr: "" };
    }
    if (verb === "daemon-reload") {
      for (const unit of loaded) if (!existsSync(fileOf(unit))) loaded.delete(unit);
      return { code: 0, stdout: "", stderr: "" };
    }
    // launchd's bootstrap names the domain and the file; the job is the file's label.
    const job = verb === "bootstrap" ? `${name}/${basename(args[2] ?? "", ".plist")}` : name;
    changes.push(`${verb} ${job}`);
    if (verb === "enable" || verb === "bootstrap") loaded.add(job);
    if (["start", "restart", "bootstrap", "kickstart"].includes(verb ?? "")) running.add(job);
    if (verb === "stop") running.delete(job);
    if (verb === "bootout" || verb === "disable") {
      running.delete(job);
      loaded.delete(job);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, changes, ports: { run, wait: async () => {} } };
}
