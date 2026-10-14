import type { ThreadId } from "@ace/protocol";
import { control, record, type EvalTask } from "./tasks.ts";

/**
 * Tasks for project knowledge, notes and asking the person (proposal stage 4). Oracle policies
 * use a capability only when the tool list offers it; otherwise they take today's path.
 */
const prAndChanges: EvalTask = {
  id: "pr-and-changes",
  title: "Is there already a PR for this work, and what is uncommitted?",
  gate: false,
  async run(world) {
    const { agent, threadId } = await world.agent({});
    world.linkPr(threadId, 42);
    world.editFile("login.ts", "export const login = () => true;\n");
    let pr: number | undefined;
    let files: string[] = [];
    if (agent.has("ace_context")) {
      const context = await agent.turn(() =>
        agent.call("ace_context", { topics: ["prs", "changes"] }),
      );
      const data = record(context.data);
      const prs = Array.isArray(data?.["prs"]) ? data["prs"] : [];
      pr = Number(record(prs[0])?.["number"]) || undefined;
      const changes = record(data?.["changes"]);
      files = Array.isArray(changes?.["files"]) ? changes["files"].map(String) : [];
    } else {
      // Today: the linked PR from the thread read, uncommitted files from the model's shell.
      const read = await agent.turn(() => agent.call("ace_thread_read", { limit: 1 }));
      const linked = record(control(read).data?.data)?.["linkedPrs"];
      pr = Number(record(Array.isArray(linked) ? linked[0] : undefined)?.["number"]) || undefined;
      files = await agent.turn(async () =>
        agent
          .ownTool("shell", { command: "git status --porcelain" }, "?? login.ts")
          .includes("login.ts")
          ? ["login.ts"]
          : [],
      );
    }
    const success = pr === 42 && files.includes("login.ts");
    return {
      metrics: agent.finish(success),
      note: success
        ? "PR #42 and login.ts found"
        : `saw PR ${String(pr)}, files ${files.join(",")}`,
    };
  },
};

/** The test command an agent runs first, and whether it was the one the project needs. */
const notesRespected: EvalTask = {
  id: "notes-respected",
  title: "A lesson from one thread reaches the next thread on another provider",
  gate: false,
  async run(world) {
    const lesson = "Run tests with `bun run test`; never `bun test`.";
    // Thread 1 learned the lesson the hard way and records it if ace lets it.
    const { agent: first } = await world.agent({ prompt: "fix the login test" });
    if (first.has("ace_note_add"))
      await first.turn(() => first.call("ace_note_add", { text: lesson }));
    // Thread 2 is asked to run the tests.
    const { agent } = await world.agent({ prompt: "run the tests" });
    const knows = agent.instructions.includes("bun run test");
    const commands = knows ? ["bun run test"] : ["bun test", "bun run test"];
    for (const command of commands)
      await agent.turn(async () =>
        agent.ownTool(
          "shell",
          { command },
          command === "bun test" ? "error: use bun run test" : "ok",
        ),
      );
    const wrong = commands.filter((command) => command === "bun test").length;
    return {
      metrics: agent.finish(wrong === 0),
      note: `${wrong} wrong test invocation(s)`,
    };
  },
};

/** Correctness: a question to the person keeps the thread waiting on them, never done. */
const askWaitsOnPerson: EvalTask = {
  id: "ask-waits-on-person",
  title: "A child's question waits on the person and its answer comes back",
  gate: false,
  async run(world) {
    const { agent: parent } = await world.agent({});
    const started = await parent.turn(() =>
      parent.call("delegate_task", {
        requestId: "asker",
        task: "Ask which login provider to use",
        role: "implementer",
        provider: "claude",
      }),
    );
    const child = record(control(started).data?.data)?.["threadId"];
    if (typeof child !== "string")
      return { metrics: parent.finish(false), note: "child not started" };
    const { agent } = await world.attach(child as ThreadId);
    if (!agent.has("ace_ask"))
      return { metrics: agent.finish(false), note: "no ace_ask for a child thread" };
    const asked = agent.call("ace_ask", {
      question: "Which login provider?",
      options: ["Email", "GitHub"],
      timeoutSeconds: 30,
    });
    const waiting = await world.whileAsking(child as ThreadId);
    await world.answerAsk(child as ThreadId, "o1");
    const answer = record((await agent.turn(() => asked)).data);
    const success =
      waiting === "needs_you" &&
      answer?.["status"] === "answered" &&
      JSON.stringify(answer["answer"]) === JSON.stringify(["GitHub"]);
    return {
      metrics: agent.finish(success),
      note: `while asking: ${String(waiting)}; answer ${JSON.stringify(answer?.["answer"])}`,
    };
  },
};

export const knowledgeTasks: readonly EvalTask[] = [prAndChanges, notesRespected, askWaitsOnPerson];
