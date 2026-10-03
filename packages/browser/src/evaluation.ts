import type { BrowserCdp } from "./backend.ts";
import { CallResult } from "./cdp.ts";
import { decodeEvaluationValue, serializeEvaluationValue } from "./evaluation-value.ts";

/** Return bounded text over CDP, then validate and decode at the trusted host. */
export async function evaluatePage(cdp: BrowserCdp, expression: string): Promise<unknown> {
  const response = CallResult.parse(
    await cdp.send("Runtime.evaluate", {
      timeout: 10_000,
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => { let timer; try {
        const value = await Promise.race([(0,eval)(${JSON.stringify(expression)}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('evaluate timeout')),10000)})]);
        return (${serializeEvaluationValue})(value);
      } finally { clearTimeout(timer); } })()`,
    }),
  );
  try {
    if (response.exceptionDetails) throw new Error("Evaluation exception");
    return decodeEvaluationValue(response.result.value);
  } catch {
    throw new Error("Browser evaluate failed or timed out");
  }
}
