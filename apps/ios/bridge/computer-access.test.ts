import { afterEach, describe, expect, test } from "vitest";
import { ComputerAccess } from "./computer-access.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * Settings › Computer use on the phone, over a real client and the fake daemon: locked computer
 * use read live and turned on and off, a refusal said as the web says it, and Use my Chrome's
 * install, connected browsers and revoke.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function opened(mac = true) {
  const { daemon, client } = sheetFixture();
  await client.start();
  const sink = new RecordingSink();
  let ids = 0;
  const access = new ComputerAccess(
    client,
    sink,
    plainPreview,
    (delay, run) => {
      const timer = setTimeout(run, delay);
      return () => clearTimeout(timer);
    },
    () => `id-${++ids}`,
  );
  closers.push(
    () => access.close(),
    () => client.close(),
  );
  access.handle({ type: "computer.access", action: { kind: "open", mac } });
  const read = () =>
    sink.read("computer:access") as
      | {
          locked: {
            label: string;
            tone: string;
            on: boolean;
            repair: boolean;
            note: string | null;
          } | null;
          chrome: {
            installed: boolean;
            extensionPath: string | null;
            connections: { title: string; summary: string }[];
          } | null;
          busy: string | null;
          error: string | null;
        }
      | undefined;
  return { daemon, access, read };
}

describe("Computer use settings on the phone", () => {
  test("locked use turns on through approval, follows the Mac live, and turns off", async () => {
    const { daemon, access, read } = await opened();
    await until(() => read()?.locked?.label === "Off", "off");
    access.handle({ type: "computer.access", action: { kind: "locked", op: "install" } });
    await until(() => read()?.locked?.label === "Needs approval", "waiting for approval");
    expect(read()?.locked).toMatchObject({ on: true, tone: "needs-you" });
    expect(read()?.locked?.note).toContain("System Settings");
    daemon.computerAccess.approve();
    await until(() => read()?.locked?.label === "On", "approved");
    daemon.computerAccess.drift("The component was moved.");
    await until(() => read()?.locked?.repair === true, "drifted");
    expect(read()?.locked).toMatchObject({
      label: "Needs repair",
      tone: "failed",
      note: "The component was moved.",
    });
    access.handle({ type: "computer.access", action: { kind: "locked", op: "repair" } });
    await until(() => read()?.locked?.label === "On", "repaired");
    access.handle({ type: "computer.access", action: { kind: "locked", op: "remove" } });
    await until(() => read()?.locked?.label === "Off" && read()?.busy === null, "off again");
  });

  test("a refused change says why in the web's words and leaves the state as it was", async () => {
    const { daemon, access, read } = await opened();
    await until(() => read()?.locked != null, "read");
    daemon.computerAccess.refuse = "forbidden";
    access.handle({ type: "computer.access", action: { kind: "locked", op: "install" } });
    await until(() => read()?.error != null, "refused");
    expect(read()?.error).toBe(
      "Couldn't turn on locked use. Only this Mac's owner can change this.",
    );
    expect(read()?.locked?.label).toBe("Off");
  });

  test("a machine that isn't a Mac never offers locked use while it's off", async () => {
    const { read } = await opened(false);
    await until(() => read()?.chrome != null, "read");
    expect(read()?.locked).toBeNull();
  });

  test("Use my Chrome installs, shows where to load the extension, and revokes", async () => {
    const { access, read } = await opened();
    await until(() => read()?.chrome != null, "status");
    expect(read()?.chrome).toMatchObject({ installed: false, extensionPath: null });
    access.handle({ type: "computer.access", action: { kind: "chrome", op: "install" } });
    await until(() => read()?.chrome?.installed === true, "installed");
    expect(read()?.chrome?.extensionPath).toBe("/Users/ada/.ace/chrome-extension");
    access.handle({ type: "computer.access", action: { kind: "chrome", op: "revoke" } });
    await until(() => read()?.chrome?.installed === false, "revoked");
  });
});
