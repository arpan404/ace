import { watch } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandRunner } from "../index.ts";

/** Real child processes, with only the installed GitHub CLI replaced. */
export async function readinessGh(
  input: {
    account?: string;
    modern?: boolean;
    /** gh exits 4: no sign-in for the host. */
    fail?: boolean;
    /** gh reaches no host: no HTTP response, exit 1. */
    offline?: boolean;
    /** `/user` answers 403 with an exhausted rate limit. */
    rateLimited?: boolean;
    changeAfter?: boolean;
    malformed?: boolean;
    wait?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "ace-readiness-"));
  const fixture = join(directory, "fixture.json");
  const script = join(directory, "gh");
  const marker = join(directory, "started");
  await writeFile(fixture, JSON.stringify(input));
  await writeFile(
    script,
    `#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';\nconst path=process.env.ACE_GH_FIXTURE; const f=JSON.parse(readFileSync(path,'utf8')); const args=process.argv.slice(2);\nif(args[0]==='--version') console.log('gh version 2.90.0');\nelse if(args.includes('--help')) console.log(f.modern ? '--json' : 'auth status');\nelse if(args[0]==='auth') console.log(JSON.stringify([{login:'octo',active:true},{login:'other',active:false}]));\nelse if(args[0]==='api' && args[1]==='user') { if(f.fail) process.exit(4); if(f.offline) { process.stderr.write('error connecting to api.github.com\\n'); process.exit(1); } const head=(status,headers={})=>{ if(args.includes('--include')) process.stdout.write('HTTP/2.0 '+status+' status\\r\\n'+Object.entries(headers).map(([k,v])=>k+': '+v+'\\r\\n').join('')+'\\r\\n'); }; if(f.rateLimited) { head(403,{'x-ratelimit-remaining':'0','x-ratelimit-reset':'2000'}); process.stdout.write(JSON.stringify({message:'API rate limit exceeded'})); process.exit(1); } head(200); console.log(f.malformed ? '{}' : JSON.stringify({login:f.account??'octo'})); }\nelse if(f.wait) { writeFileSync(process.env.ACE_GH_STARTED,String(process.pid)); setInterval(()=>{},1000); }\nelse { console.log(JSON.stringify({result:'ok'})); if(f.changeAfter) writeFileSync(path,JSON.stringify({...f,account:'other'})); }\n`,
    { mode: 0o755 },
  );
  // Extensionless ESM executable needs its own package boundary.
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  return {
    directory,
    runner: createCommandRunner({
      cwd: directory,
      env: { PATH: directory, ACE_GH_FIXTURE: fixture, ACE_GH_STARTED: marker },
      timeoutMs: 10_000,
    }),
    started() {
      return new Promise<number>((resolve, reject) => {
        const watcher = watch(directory, check);
        function check() {
          void readFile(marker, "utf8").then(
            (pid) => {
              watcher.close();
              resolve(Number(pid));
            },
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") {
                watcher.close();
                reject(error);
              }
            },
          );
        }
        check();
      });
    },
    update: (value: typeof input) => writeFile(fixture, JSON.stringify(value)),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
