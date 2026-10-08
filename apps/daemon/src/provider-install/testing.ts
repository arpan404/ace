import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ProviderInstalls } from "./sessions.ts";
import { ProviderStatuses } from "../provider-status.ts";
import type { ProviderInstallProgress, ProviderInstallRequest } from "@ace/protocol";

export async function installFixture(
  options: { writable?: boolean; managers?: readonly string[] } = {},
) {
  const node = process.execPath;
  const home = await mkdtemp(join(tmpdir(), "ace-install-"));
  const bin = join(home, "bin");
  const root = join(home, "npm", "lib", "node_modules");
  const brewRoot = join(home, "brew");
  const bunRoot = join(home, ".bun", "bin");
  await Promise.all([bin, root, brewRoot, bunRoot].map((path) => mkdir(path, { recursive: true })));
  const env = {
    ...process.env,
    HOME: home,
    PATH: bin,
    ACE_INSTALL_ROOT: root,
    ACE_BREW_ROOT: brewRoot,
    ACE_BUN_BIN: bunRoot,
    ACE_INSTALL_BIN: bin,
    ACE_INSTALL_CALLS: join(home, "calls"),
    ACE_INSTALL_NODE: node,
    NPM_TOKEN: "a-private-package-manager-token",
  };
  await writeFile(join(home, "latest"), "2.0.0");
  const agentSource = `#!${node}\nimport { readFileSync } from 'node:fs';\nif (process.argv.includes('--version')) console.log(readFileSync(process.env.HOME + '/installed-version', 'utf8'));\nelse if (process.argv.slice(2).join(' ') === 'login status') console.log('Not logged in');\nelse if (process.argv.slice(2).join(' ') === 'auth status') console.log('{"loggedIn":false}');\nelse process.exit(1);\n`;
  const invalidSource = `#!${node}\nconsole.log("unknown-version");\n`;
  const source = `import { appendFileSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
const manager = basename(process.argv[1]);
const args = process.argv.slice(2);
const home = process.env.HOME;
appendFileSync(process.env.ACE_INSTALL_CALLS, JSON.stringify([manager, ...args]) + '\\n');
if (args.join(' ') === 'root -g') console.log(process.env.ACE_INSTALL_ROOT);
else if (args.join(' ') === '--prefix') console.log(process.env.ACE_BREW_ROOT);
else if (args.join(' ') === 'pm bin -g') console.log(process.env.ACE_BUN_BIN);
else if (args[0] === 'view' || args[0] === 'info') {
  const version = readFileSync(home + '/latest', 'utf8').trim();
  if (version === 'offline') process.exit(1);
  console.log(args[0] === 'view' ? version : JSON.stringify({formulae:[{versions:{stable:version}}],casks:[{version}]}));
} else {
  const mode = existsSync(home + '/mode') ? readFileSync(home + '/mode', 'utf8') : '';
  if (mode === 'invalid') { writeFileSync(join(process.env.ACE_INSTALL_BIN,'codex'), ${JSON.stringify(invalidSource)}, {mode:0o755}); }
  else if (mode === 'hang') {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},100000)"], {stdio:['ignore','inherit','inherit','ipc']});
    child.on('message', () => console.log('child=' + child.pid));
    process.on('SIGTERM',()=>{});
    setInterval(()=>{}, 100000);
  } else if (mode === 'fail') { console.error('password=not-for-clients'); process.exit(7); }
  else {
    const pkg = args.at(-1).replace(/@latest$/, '');
    const name = pkg.includes('claude') ? 'claude' : pkg.includes('opencode') ? 'opencode' : pkg.includes('pi-coding') ? 'pi' : 'codex';
    const target = manager === 'brew' ? join(process.env.ACE_BREW_ROOT, args.includes('--cask') ? 'Caskroom' : 'Cellar', pkg, '2.0.0', name) : manager === 'bun' ? join(home,'.bun','install','global','node_modules',pkg,name) : join(process.env.ACE_INSTALL_ROOT, pkg, name);
    if (args[0] === 'uninstall' || args[0] === 'remove') { rmSync(join(process.env.ACE_INSTALL_BIN,name), {force:true}); rmSync(target,{force:true}); }
    else {
      mkdirSync(join(target,'..'), {recursive:true});
      writeFileSync(target, ${JSON.stringify(agentSource)}, {mode:0o755});
      rmSync(join(process.env.ACE_INSTALL_BIN,name), {force:true});
      symlinkSync(target,join(process.env.ACE_INSTALL_BIN,name));
      writeFileSync(home + '/installed-version','2.0.0');
      for(let i=0;i<130;i++) console.log('progress '+i);
      console.log('\\u001b[31mfinished\\u001b[0m NPM_TOKEN=' + (process.env.NPM_TOKEN ?? 'none'));
    }
  }
}`;
  for (const name of options.managers ?? ["npm", "brew", "bun"])
    await writeFile(join(bin, name), `#!${node}\n${source}`, { mode: 0o755 });
  let now = 1000;
  const logs: string[] = [];
  const events: ProviderInstallProgress[] = [];
  const waiters = new Set<{
    match: (event: ProviderInstallProgress) => boolean;
    resolve: (event: ProviderInstallProgress) => void;
  }>();
  let installs: ProviderInstalls | undefined;
  const statuses = new ProviderStatuses(
    {
      env,
      cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "SDK login" }),
      async versions(row, signal) {
        if (!installs) return {};
        const plan = await installs.planner.plan(
          { provider: row.provider },
          "update",
          undefined,
          signal,
        );
        return installs.versions.check(plan, signal);
      },
    },
    { now: () => now, schedule: () => () => {} },
  );
  const sessions = new ProviderInstalls(
    {
      env,
      home,
      ...(options.writable === undefined
        ? {}
        : { writable: async () => options.writable === true }),
    },
    {
      now: () => now,
      id: () => `install-${events.length}-${++counter}`,
      schedule(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
      log: (line) => logs.push(line),
      async changed() {
        await statuses.refreshAfterMutation();
        statuses.publish();
      },
    },
  );
  installs = sessions;
  let counter = 0;
  sessions.listen((_owner, event) => {
    events.push(event);
    for (const waiter of waiters)
      if (waiter.match(event)) {
        waiters.delete(waiter);
        waiter.resolve(event);
      }
  });
  return {
    home,
    bin,
    root,
    brewRoot,
    bunRoot,
    env,
    installs: sessions,
    statuses,
    events,
    logs,
    tick(ms: number) {
      now += ms;
    },
    async calls(): Promise<string[][]> {
      const raw = await readFile(join(home, "calls"), "utf8").catch(() => "");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => z.array(z.string()).parse(JSON.parse(line)));
    },
    async existing(provider: string, method: "npm" | "brew" | "script" | "bun" = "npm") {
      const pkg =
        provider === "claude"
          ? "@anthropic-ai/claude-code"
          : provider === "opencode"
            ? "@opencode/cli"
            : "@openai/codex";
      const target =
        method === "brew"
          ? join(
              brewRoot,
              "Caskroom",
              provider === "claude" ? "claude-code" : provider,
              "1.0.0",
              provider,
            )
          : method === "script"
            ? join(home, ".local", "bin", provider)
            : method === "bun"
              ? join(home, ".bun", "install", "global", "node_modules", pkg, provider)
              : join(root, pkg, provider);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, agentSource, { mode: 0o755 });
      await writeFile(join(home, "installed-version"), "1.0.0");
      if (method === "script") {
        env.PATH = `${join(home, ".local", "bin")}:${bin}`;
      } else await symlink(target, join(bin, provider));
      return target;
    },
    request(request: ProviderInstallRequest, owner = "phone") {
      return sessions.handle(owner, request);
    },
    wait(match: (event: ProviderInstallProgress) => boolean): Promise<ProviderInstallProgress> {
      const previous = events.findLast(match);
      return previous
        ? Promise.resolve(previous)
        : new Promise((resolve) => waiters.add({ match, resolve }));
    },
    async close() {
      await sessions.close();
      await statuses.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
