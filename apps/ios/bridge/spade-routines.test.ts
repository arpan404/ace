import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";

/*
 * A bot's routines on the iPhone's profile: the list with when each runs, pausing, Run now,
 * retiming, a new routine, Delete, and the heartbeat, against the fake Spade.
 */

const zone = "Europe/Lisbon";

async function withWriter() {
  const host = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.routines.agentRoute("POST", "writer", "routines", {
      name: "Morning brief",
      instruction: "Sum up the night",
      trigger: { kind: "schedule", schedule: "weekdays at 9:00" },
    });
  });
  await until(() => host.patches.state?.list.rows?.some((row) => row.id === "writer") === true);
  const list = async () => {
    const answer = await host.ask({ type: "spade.routines", agentId: "writer" });
    if (!("routines" in answer)) throw new Error(JSON.stringify(answer));
    return answer;
  };
  return { ...host, list };
}

test("a bot's routines list with when each runs, and its heartbeat off", async () => {
  const { list } = await withWriter();

  const { routines, heartbeat } = await list();

  expect(routines).toMatchObject([
    {
      name: "Morning brief",
      instruction: "Sum up the night",
      paused: false,
      failed: false,
      trigger: { kind: "schedule", schedule: "weekdays at 9:00" },
    },
  ]);
  expect(routines[0]?.line).toMatch(/^Weekdays at 9:00/);
  expect(heartbeat).toMatchObject({ enabled: false, line: "Off", everyMinutes: 30 });
});

test("a paused routine reads Paused and won't run until it's resumed", async () => {
  const { ask, list, api: fake } = await withWriter();
  const [routine] = (await list()).routines;
  if (!routine) throw new Error("no routine");

  expect(await ask({ type: "spade.routine.pause", id: routine.id, paused: true })).toEqual({
    ok: true,
  });
  const paused = (await list()).routines[0];
  expect(paused).toMatchObject({ paused: true });
  expect(paused?.line).toMatch(/Paused/);

  const refused = await ask({ type: "spade.routine.run", id: routine.id });
  expect(refused).toMatchObject({ ok: false, title: "Couldn't run it" });
  expect(fake.routines.routines[0]?.last_run).toBeNull();

  await ask({ type: "spade.routine.pause", id: routine.id, paused: false });
  expect(await ask({ type: "spade.routine.run", id: routine.id })).toEqual({ ok: true });
  expect(fake.routines.routines[0]?.last_run).toMatchObject({ cause: "manual" });
});

test("retiming a routine sends the new schedule in the phone's zone, and keeps it otherwise", async () => {
  const { ask, list, api: fake } = await withWriter();
  const [routine] = (await list()).routines;
  if (!routine) throw new Error("no routine");

  const renamed = await ask({
    type: "spade.routine.save",
    agentId: "writer",
    id: routine.id,
    name: "Brief",
    instruction: "Sum up the night",
    timeZone: zone,
  });
  expect(renamed).toMatchObject({ ok: true, routine: { name: "Brief" } });
  // No new trigger: the schedule and the zone it was written in stay.
  expect(fake.routines.routines[0]).toMatchObject({
    trigger: { schedule: "weekdays at 9:00" },
    time_zone: "UTC",
  });

  const retimed = await ask({
    type: "spade.routine.save",
    agentId: "writer",
    id: routine.id,
    name: "Brief",
    instruction: "Sum up the night",
    trigger: { kind: "schedule", schedule: "every 2 hours" },
    timeZone: zone,
  });
  expect(retimed).toMatchObject({
    ok: true,
    routine: { line: expect.stringMatching(/^Every 2 hours/) },
  });
  expect(fake.routines.routines[0]).toMatchObject({ time_zone: zone });
});

test("a routine made on the phone is the bot's next to run, and Delete takes it away", async () => {
  const { ask, list, api: fake } = await withWriter();

  const added = await ask({
    type: "spade.routine.save",
    agentId: "writer",
    name: "Evening",
    instruction: "Wrap up",
    trigger: { kind: "schedule", schedule: "daily at 18:00" },
    timeZone: zone,
  });

  if (!("routine" in added)) throw new Error(JSON.stringify(added));
  expect(added.routine.line).toMatch(/^Every day at 18:00/);
  expect(fake.routines.routines.find((each) => each.name === "Evening")).toMatchObject({
    agent: "writer",
    time_zone: zone,
    next_run: expect.any(Number),
  });

  await ask({ type: "spade.routine.delete", id: added.routine.id });
  expect((await list()).routines.map((each) => each.name)).toEqual(["Morning brief"]);
});

test("a schedule Spade can't read comes back in its words, and nothing is added", async () => {
  const { ask, list } = await withWriter();

  const refused = await ask({
    type: "spade.routine.save",
    agentId: "writer",
    name: "Odd",
    instruction: "Do it",
    trigger: { kind: "schedule", schedule: "now and then" },
    timeZone: zone,
  });

  expect(refused).toMatchObject({ ok: false, title: "Couldn't save the routine" });
  expect((refused as { message: string }).message).toMatch(/schedule/);
  expect((await list()).routines).toHaveLength(1);
});

test("the heartbeat turns on with its checklist, how often and quiet hours, and off again", async () => {
  const { ask, list } = await withWriter();

  const none = await ask({
    type: "spade.heartbeat.save",
    agentId: "writer",
    enabled: true,
    timeZone: zone,
  });
  expect(none).toMatchObject({ ok: false, title: "Couldn't turn the heartbeat on" });

  await ask({
    type: "spade.heartbeat.save",
    agentId: "writer",
    enabled: true,
    everyMinutes: 60,
    checklist: "Is the build green?",
    quiet: { start: "22:00", end: "07:00" },
    timeZone: zone,
  });
  const on = (await list()).heartbeat;
  expect(on).toMatchObject({ enabled: true, everyMinutes: 60, checklist: "Is the build green?" });
  expect(on?.line).toMatch(/^Every hour · quiet 22:00 to 07:00 · next /);

  await ask({ type: "spade.heartbeat.save", agentId: "writer", enabled: false, timeZone: zone });
  expect((await list()).heartbeat).toMatchObject({ enabled: false, line: "Off" });
});
