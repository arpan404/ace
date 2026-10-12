import type { ClientApi, Scheduler, Storage } from "@ace/client";
import { Command, ThreadId } from "@ace/protocol";
import { z } from "zod";

function ready(client: ClientApi, scheduler: Scheduler): Promise<void> {
  return new Promise((resolve, reject) => {
    const state = client.connectionState();
    const cancel = scheduler.set(120000, () => {
      stop();
      reject(new Error("Fixture did not become ready"));
    });
    const stop = state.subscribe(() => {
      if (state.getSnapshot() === "ready") {
        stop();
        cancel();
        resolve();
      } else if (state.getSnapshot() === "fatal") {
        stop();
        cancel();
        reject(new Error("Fixture connection failed"));
      }
    });
    if (state.getSnapshot() === "ready") {
      stop();
      cancel();
      resolve();
    }
  });
}
const Record = z.object({ command: Command });
export async function replayProbe(
  client: ClientApi,
  storage: Storage,
  scheduler: Scheduler,
  url: string | null,
): Promise<void> {
  if (!url) return;
  const parsed = new URL(url);
  if (parsed.protocol !== "ace:" || parsed.hostname !== "spike") return;
  const [action, run] = parsed.pathname.split("/").filter(Boolean);
  if ((action !== "offline-send" && action !== "replay") || !run || !/^[a-z0-9-]{1,48}$/.test(run))
    return;
  const id = `android-spike-${run}`;
  const diskIds = async () =>
    ((await storage.records?.load()) ?? []).map((raw) => Record.parse(JSON.parse(raw)).command.id);
  // This helper is called only inside the debug-only loopback fixture runtime.
  console.info("AceSpikeReplay", JSON.stringify({ stage: "loaded", id, diskIds: await diskIds() }));
  await ready(client, scheduler);
  if (action === "offline-send") {
    client.networkOnline(false);
    await client.enqueue(
      {
        type: "thread.send",
        threadId: ThreadId.parse("stream-thread"),
        input: [{ type: "text", text: `Android restart replay ${run}` }],
        delivery: "steer",
      },
      id,
    );
    console.info(
      "AceSpikeReplay",
      JSON.stringify({ stage: "saved-offline", id, diskIds: await diskIds() }),
    );
  } else {
    const intent = client.intent(id);
    if (intent.getSnapshot()?.state !== "acked" && intent.getSnapshot()?.state !== "failed") {
      await new Promise<void>((resolve, reject) => {
        const cancel = scheduler.set(30000, () => {
          stop();
          reject(new Error("Replay receipt did not arrive"));
        });
        const stop = intent.subscribe(() => {
          const value = intent.getSnapshot();
          if (value?.state === "acked" || value?.state === "failed") {
            stop();
            cancel();
            resolve();
          }
        });
      });
    }
    console.info(
      "AceSpikeReplay",
      JSON.stringify({
        stage: "receipt",
        id,
        state: intent.getSnapshot()?.state,
        diskIds: await diskIds(),
      }),
    );
  }
}
