import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCursorAccountDriver, CursorHostSlots } from "./index.ts";

const fakeHost = `
import { createInterface } from 'node:readline';
import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
const root=join(process.env.HOME,'.cursor','sdk'), file=join(root,'auth.json');
const out=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',async(line)=>{
 const input=JSON.parse(line);
 if(input.method==='login'){
  await mkdir(root,{recursive:true});await writeFile(file,'fake-sentinel');
  out({method:'login-url',params:{url:'https://cursor.com/login?challenge=fake'}});
 }else if(input.method==='logout'){
  await rm(file,{force:true});out({id:input.id,result:{status:'logged-out',source:'none'}});
 }else if(input.method==='status'){
  let exists=true;try{await access(file);}catch{exists=false;}
  out({id:input.id,result:{status:exists?'logged-in':'logged-out',source:exists?'sdk-store':'none'}});
 }
});
`;

it("stops an outstanding selected-instance login before deleting its SDK auth store", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-login-exit-"));
  const lifetime = new AbortController();
  let pendingLogin: Promise<unknown> | undefined;
  try {
    const entry = join(home, "auth-host.mjs");
    await writeFile(entry, fakeHost);
    const started = Promise.withResolvers<void>();
    const driver = createCursorAccountDriver({
      launchEnv: {},
      entry,
      slots: new CursorHostSlots(2),
      stopInstance: async () => {},
      discovery: {
        platform: "darwin",
        arch: "arm64",
        nodeVersion: "24.0.0",
        resolve: (id) => (id === "@cursor/sdk" ? "/sdk/dist/esm/index.js" : "/helper/package.json"),
        read: async (path) =>
          path === "/sdk/package.json"
            ? '{"name":"@cursor/sdk","version":"1.0.35"}'
            : '{"name":"@cursor/sdk-darwin-arm64","version":"1.0.35"}',
        executable: async () => {},
      },
    });
    const instance = { id: "selected", homeDir: home };
    let loginEnded = false;
    pendingLogin = driver
      .login(instance, lifetime.signal, () => started.resolve())
      .catch(() => {
        loginEnded = true;
      });
    await started.promise;
    expect(await driver.logout(instance, lifetime.signal)).toEqual({
      status: "logged-out",
      source: "none",
    });
    expect(loginEnded).toBe(true);
    await expect(access(join(home, "user", ".cursor", "sdk", "auth.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await driver.status(instance, lifetime.signal)).toEqual({
      status: "logged-out",
      source: "none",
    });
  } finally {
    lifetime.abort();
    await pendingLogin;
    await rm(home, { recursive: true, force: true });
  }
});
