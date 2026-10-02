import { expect,it } from "vitest";
import { harness,definition,deferred } from "./service-test-support.ts";
import type { ExecutionResult } from "./index.ts";
it("releases obsolete executor monitoring subscriptions across repeated stop and start",async()=> {
  const h=harness();const active=new Set<symbol>();const responses:ReturnType<typeof deferred<ExecutionResult>>[]=[];
  const watch=(signal?:AbortSignal)=>{const token=Symbol();active.add(token);const response=deferred<ExecutionResult>();responses.push(response);
    signal?.addEventListener("abort",()=>{active.delete(token);response.resolve({threadId:"obsolete",status:"succeeded",result:"obsolete"});},{once:true});return response.promise;};
  h.deps.executor={execute(_input,signal?:AbortSignal){return watch(signal);},recover(_key,signal?:AbortSignal){return watch(signal);}};
  try {
    h.service.put(definition());h.service.trigger("triage",{key:"once",variables:{subject:"issues"}});
    for(let i=0;i<20;i++){h.service.stop();h.service.start();}
    expect(active.size).toBe(1);h.service.stop();expect(active.size).toBe(0);await h.service.settled();
    expect(h.service.inbox().runs).toMatchObject([{status:"running"}]);
  }finally{for(const response of responses)response.resolve({threadId:"cleanup",status:"succeeded",result:"cleanup"});h.service.stop();}
});
