import { watch, type FSWatcher } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SettingsService } from "@ace/settings";
import { createCommandRunner } from "@ace/forge";
import { SourceControl } from "./source-control.ts";

const stateSchema = z.object({
  creates: z.number(),
  account: z.string(),
  loseReply: z.boolean(),
  hold: z.boolean(),
  remote: z.json().nullable(),
});
/** Only gh is substituted: SQLite, filesystem, Git and command receipts remain real. */
export async function publicationCli(options: { loseReply?: boolean; hold?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ace-publication-cli-"));
  const path = join(root, "state.json");
  const watchers = new Set<FSWatcher>();
  await writeFile(
    path,
    JSON.stringify({
      creates: 0,
      account: "octo",
      loseReply: options.loseReply ?? false,
      hold: options.hold ?? false,
      remote: null,
    }),
  );
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    join(root, "gh"),
    `#!${process.execPath}
import {readFileSync,writeFileSync,watch} from 'node:fs';
const path=process.env.ACE_PUBLICATION_STATE;
const state=JSON.parse(readFileSync(path,'utf8'));
const args=process.argv.slice(2);
let text=''; for await (const chunk of process.stdin) text+=chunk;
if(args[0]==='api' && args[1]==='user'){ console.log(JSON.stringify({login:state.account})); }
else {
 const reply=(status,body)=>{console.log('HTTP/2.0 '+status+' status\\r\\n\\r'); console.log(JSON.stringify(body)); if(status>=400) process.exitCode=1;};
 if(args[1]==='user/repos' || args[1]?.startsWith('orgs/')) {
   const body=JSON.parse(text); state.creates++;
   state.remote={id:state.creates,name:body.name,owner:{login:args[1]==='user/repos'?state.account:args[1].split('/')[1]},description:body.description,private:body.private,archived:false,fork:false};
   writeFileSync(path,JSON.stringify(state));
   if(state.hold) await new Promise(resolve=>{ const w=watch(path,()=>{try { if(!JSON.parse(readFileSync(path,'utf8')).hold){w.close();resolve()} }catch{}}); });
   reply(state.loseReply?500:201,state.remote);
 } else reply(state.remote?200:404,state.remote??{message:'missing'});
}`,
    { mode: 0o755 },
  );
  const settings = new SettingsService({ dataDir: root });
  const source = new SourceControl(
    settings,
    () => createCommandRunner({ cwd: root, env: { PATH: root, ACE_PUBLICATION_STATE: path } }),
    root,
    () => 1000,
  );
  return {
    root,
    source,
    settings,
    async state() {
      return stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    },
    created(): Promise<void> {
      return new Promise((resolve) => {
        const inspect = async () => {
          try {
            if (stateSchema.parse(JSON.parse(await readFile(path, "utf8"))).creates > 0) {
              watcher.close();
              watchers.delete(watcher);
              resolve();
            }
          } catch {
            // A write notification may precede the completed JSON write; wait for its next event.
          }
        };
        const watcher = watch(path, () => void inspect());
        watchers.add(watcher);
        void inspect();
      });
    },
    async update(patch: Partial<z.infer<typeof stateSchema>>) {
      await writeFile(
        path,
        JSON.stringify({
          ...stateSchema.parse(JSON.parse(await readFile(path, "utf8"))),
          ...patch,
        }),
      );
    },
    async close() {
      for (const watcher of watchers) watcher.close();
      source.close();
      await settings.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
