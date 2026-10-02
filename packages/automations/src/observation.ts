/** Cancel observation even when a boundary fails to settle its original promise. */
export function observe<T>(operation:Promise<T>,signal:AbortSignal):Promise<T|undefined> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted){void operation.catch(()=>{});resolve(undefined);return;}
    let finished=false;
    const cleanup=()=>{if(finished)return false;finished=true;signal.removeEventListener("abort",abort);return true;};
    const abort=()=>{if(cleanup())resolve(undefined);};
    signal.addEventListener("abort",abort,{once:true});
    void operation.then((result)=>{if(cleanup())resolve(result);},(error:unknown)=>{if(cleanup())reject(error);});
  });
}
