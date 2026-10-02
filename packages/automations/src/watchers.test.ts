import { expect,it } from "vitest";
import { harness,definition } from "./service-test-support.ts";
import type { AutomationEvent } from "@ace/protocol";
it("rolls back a failed workspace subscription and lets an identical retry watch files",async()=> {
  const h=harness();let fail=true;
  h.deps.workspace={subscribe(path,_paths,receive){if(fail)throw new Error("watcher unavailable");h.watches.set(path,receive);return ()=>{h.watches.delete(path);};}};
  const auto=definition({trigger:{kind:"file",paths:["src/**"]}});
  expect(()=>h.service.put(auto)).toThrow("watcher unavailable");
  expect(h.service.list()).toEqual([]);
  fail=false;h.service.put(auto);await h.watches.get("/project")?.({key:"changed",variables:{subject:"src/main.ts"}});
  expect(h.inputs[0]?.prompt).toBe("Triage src/main.ts");await h.finish();
});
it("attempts every watcher cleanup and ignores retained callbacks after stop",async()=> {
  const h=harness();const callbacks=new Map<string,(event:AutomationEvent)=>Promise<void>>();const active=new Set<string>();
  h.deps.workspace={subscribe(path,_paths,receive){callbacks.set(path,receive);active.add(path);return ()=>{if(path==="/first")throw new Error("first cleanup failed");active.delete(path);};}};
  h.service.put(definition({id:"first",workspace:"/first",trigger:{kind:"file",paths:["src/**"]}}));
  h.service.put(definition({id:"second",workspace:"/second",trigger:{kind:"file",paths:["src/**"]}}));
  expect(()=>h.service.stop()).not.toThrow();expect(active.has("/second")).toBe(false);
  await callbacks.get("/first")?.({key:"late",variables:{subject:"late change"}});
  expect(h.inputs).toEqual([]);expect(h.errors).toEqual([expect.objectContaining({message:"first cleanup failed"})]);
});
