import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { DeviceId, type Notification } from "@ace/protocol";
import { OffshiftView, type OffshiftRequest } from "@ace/protocol/offshift";
import { createDaemonNotifications } from "../notifications.ts";
import { daemonFixture } from "./daemon-test-support.ts";
import { end, start } from "../engine/test-support.ts";

const execute = promisify(execFile);

test("a settled tree tells the person where its run stopped, and a delivered run once", async () => {
  const f = await daemonFixture();
  const home = await mkdtemp(join(tmpdir(), "ace-offshift-notify-"));
  const notices: Notification[] = [];
  const errors: unknown[] = [];
  const notifications = createDaemonNotifications(
    home,
    f.daemon.store,
    (error) => errors.push(error),
    {},
    0,
  );
  notifications.setSender((_device, notification) => {
    notices.push(notification);
    return true;
  });
  try {
    await notifications.ready();
    await notifications.service.register(DeviceId.parse("browser"), {
      channel: "websocket",
      platform: "web",
    });
    await execute("git", ["init"], { cwd: f.h.home });
    await writeFile(join(f.h.home, ".gitignore"), "*\n!.gitignore\n!work.txt\n");
    await writeFile(join(f.h.home, "work.txt"), "done");
    const thread = f.caller.threadId;
    // Notification delivery runs on the real clock and drops alerts older than a day.
    f.h.clock.time = Date.now();
    const call = async (request: OffshiftRequest) => {
      const result = await f.call({ op: "offshift", request });
      if (!result.ok) throw new Error(`offshift ${request.action} refused: ${result.hint}`);
      return OffshiftView.parse(result.data);
    };
    await f.h.emit(thread, start);
    const started = await call({
      action: "start",
      runId: "login",
      outcome: "Sign-in shows an error for a bad password",
      endpoint: "local",
      criteria: [{ id: "error", description: "Error shows", requiredKinds: ["source"] }],
    });
    // The sidebar carries where the run stands, without ids.
    expect(
      f.daemon.store.sidebarPage({ limit: 10 }).threads.find((entry) => entry.id === thread)?.run,
    ).toEqual({ phase: "plan", state: "open", pendingCount: 1 });
    // The agent ends its turn with the run still in plan.
    await f.h.emit(thread, end);
    await f.daemon.engine?.flush();
    await notifications.tick();
    expect(notices).toEqual([
      expect.objectContaining({
        threadId: thread,
        status: "done",
        run: { outcome: "stopped", phase: "plan" },
        message: `Run stopped at Plan: ${started.next}`,
      }),
    ]);
    await notifications.tick();
    expect(notices).toHaveLength(1);

    // Picked up again and taken to delivery with its check current.
    await f.h.emit(thread, start);
    let version = started.run.version;
    for (const phase of ["implement", "verify"] as const)
      version = (await call({ action: "advance", runId: "login", version, phase, note: phase })).run
        .version;
    const checked = await call({
      action: "evidence",
      runId: "login",
      version,
      evidence: [
        {
          criterionId: "error",
          kind: "source",
          result: "pass",
          revision: started.revision,
          action: "Read the diff",
          artifact: "report",
          note: "The error renders",
        },
      ],
    });
    version = checked.run.version;
    for (const phase of ["review", "delivery"] as const)
      version = (await call({ action: "advance", runId: "login", version, phase, note: phase })).run
        .version;
    await f.h.emit(thread, end);
    await f.daemon.engine?.flush();
    await notifications.tick();
    expect(notices[1]).toMatchObject({
      status: "done",
      run: { outcome: "delivered", phase: "delivery" },
      message: "Run delivered",
    });
    // Another settle at the same run version is an ordinary finished notice.
    await f.h.emit(thread, start);
    await f.h.emit(thread, end);
    await f.daemon.engine?.flush();
    await notifications.tick();
    expect(notices).toHaveLength(3);
    expect(notices[2]?.status).toBe("done");
    expect(notices[2]?.run).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await notifications.close();
    await f.daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
