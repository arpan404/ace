import { DatabaseSync } from "node:sqlite";
import { expect,it } from "vitest";
import { harness,definition } from "./service-test-support.ts";
it("lists, restarts and admits manual work without decoding unrelated poll state",async()=> {
  const h=harness();const auto=definition({trigger:{kind:"github",repository:"user/project",event:"pr_changed",pollIntervalMs:60_000}});h.service.put(auto);
  const db=new DatabaseSync(h.storePath);try{db.prepare("UPDATE automation_jobs SET state=? WHERE id=?").run("not valid JSON",auto.id);}finally{db.close();}
  expect(()=>h.service.list()).not.toThrow();expect(h.service.list()).toEqual([auto]);
  expect(()=>h.restart()).not.toThrow();expect(h.service.trigger(auto.id,{key:"manual:valid",variables:{subject:"issues"}}).status).toBe("running");await h.finish();
});
