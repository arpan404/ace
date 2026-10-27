import { facts, ScenarioPlayer, type FakeDaemon, type Step } from "@ace/fake-daemon";
import { act, cleanup, configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
afterEach(cleanup);

type Fact = Extract<Step, { kind: "facts" }>["facts"][number];
const names = ["alpha", "beta", "gamma"];
const tick = () => new Promise((resolve) => setTimeout(resolve, 6));

/** A Claude thread whose root started three subagents, each still answering. */
function parallelReview(daemon: FakeDaemon) {
  const opening: Fact[] = [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Review the change in three parts"),
    ...names.flatMap((name): Fact[] => [
      facts.tool("root", `spawn-${name}`, {
        kind: "agent.spawn",
        title: `Review ${name}`,
        detail: { kind: "agent.spawn", childAgent: name },
      }),
      facts.subagent("claude", name, `Review ${name}`, `spawn-${name}`),
      facts.turn(name, "spawn"),
      facts.message(name, `answer-${name}`, "assistant", "Reading", false),
    ]),
  ];
  new ScenarioPlayer(daemon, {
    thread: { id: "parallel", workspaceId: "relay", provider: "claude", title: "Parallel review" },
    steps: [{ kind: "facts", facts: opening }],
  }).runUntilBlocked();
}

/** Every subagent reads one more file and adds to its answer, a frame apart. */
async function round(daemon: FakeDaemon, at: number) {
  for (const name of names)
    await act(async () => {
      daemon.apply("parallel", [
        facts.tool(name, `read-${name}-${at}`, {
          kind: "file.read",
          title: `Read f${at}.ts`,
          detail: { kind: "file.read", path: `/Users/dev/acme/f${at}.ts` },
        }),
      ]);
      await tick();
    });
  for (const name of names)
    await act(async () => {
      daemon.apply("parallel", [
        facts.toolDone(name, `read-${name}-${at}`),
        facts.stream(name, `answer-${name}`, ` step ${at}`),
      ]);
      await tick();
    });
}

test("a subagent's page keeps its own work while its siblings stream past the live tail", async () => {
  // This Mac with two other machines; the thread runs on the build server.
  const app = harness({
    machines: [
      { hostId: "build", name: "Build server" },
      { hostId: "ci", name: "CI box" },
    ],
  });
  const build = app.machines.get("build");
  if (!build) throw new Error("no build server");
  parallelReview(build);
  await app.open("/t/parallel?machine=build");
  const parent = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(await within(parent).findByRole("button", { name: "3 subagents" }));
  await userEvent.click(
    await within(parent).findByRole("link", { name: "Open Review alpha, Running" }),
  );
  const page = await screen.findByRole("feed", { name: "Transcript" });
  await within(page).findByText(/Reading/);

  // Three subagents' 300 reads are more than the thread's shared live tail holds.
  for (let at = 0; at < 100; at++) await round(build, at);

  // Alpha's answer, older than every read, still shows with what it had written, and every
  // one of its reads is still on its page.
  expect(within(page).getByText(/^Reading step 0 step 1 step 2/)).toBeTruthy();
  expect(within(page).getByText(/100 files/)).toBeTruthy();
}, 120_000);
