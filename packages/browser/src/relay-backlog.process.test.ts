import { expect, it } from "vitest";
import { z } from "zod";
import type { BrowserBackendRequest } from "@ace/protocol";
import { backendFixture } from "./backend-test-support.ts";

const Decision = z.object({
  operation: z.object({ params: z.object({ params: z.object({ requestId: z.string() }) }) }),
});

it("every paused request gets its decision when more requests pause than the relay admits", async () => {
  const f = await backendFixture({}, { nativeTabs: true });
  await f.open();
  const sessionId = [...f.pages.keys()][0];
  if (!sessionId) throw new Error("Missing session");
  // An ad-heavy page pauses hundreds of requests at once while the desktop is slow to answer.
  f.hold("Fetch.continueRequest");
  const decided = new Set<string>();
  const unanswered: BrowserBackendRequest[] = [];
  f.requests.on("Fetch.continueRequest", (request: BrowserBackendRequest) => {
    decided.add(Decision.parse(request).operation.params.params.requestId);
    unanswered.push(request);
  });
  const paused = 300;
  for (let index = 0; index < paused; index++)
    f.sendEvent(sessionId, "ace.tabs.event", {
      tabId: "native-tab",
      method: "Fetch.requestPaused",
      params: {
        requestId: `request-${index}`,
        request: { url: `http://127.0.0.1:8080/script-${index}.js` },
        resourceType: "Script",
        frameId: "main",
      },
    });
  await expect.poll(() => decided.size).toBeGreaterThan(0);
  // The desktop catches up; every request must still be continued, none left hanging.
  await expect
    .poll(() => {
      for (const request of unanswered.splice(0)) f.reply(request, {});
      return decided.size;
    })
    .toBe(paused);
  expect(f.service.state("thread")).toMatchObject({ closed: false });
});
