import { expect, test } from "vitest";
import { createCommandRunner, GitHubRepositories } from "./index.ts";
import { fakeGh } from "./testing/fixtures.ts";

const row = {
  id: 1,
  name: "engine",
  owner: { login: "octo" },
  description: "Coding",
  private: true,
  archived: false,
  fork: false,
  future: { enabled: true },
};
const listPath = (page: number) =>
  `user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=${page}`;
const input = {
  host: "github.com",
  account: "octo",
  query: "",
  visibility: "all",
  archived: "all",
  fork: "all",
} as const;
const signal = () => new AbortController().signal;
async function setup(records: Parameters<typeof fakeGh>[0]) {
  const fixture = await fakeGh(records);
  const runner = createCommandRunner({
    cwd: fixture.dir,
    env: {
      PATH: `${fixture.dir}:${process.env.PATH ?? ""}`,
      FORGE_FIXTURE: `${fixture.dir}/fixtures.json`,
      FORGE_STATE: `${fixture.dir}/state.json`,
    },
  });
  return {
    ...fixture,
    repositories: new GitHubRepositories({
      host: "github.com",
      account: "octo",
      runner,
      now: () => 1000,
    }),
  };
}
test("repository discovery combines accessible pages and explicit owner visibility archive fork and search filters", async () => {
  const fixture = await setup({
    [listPath(1)]: [
      {
        body: Array.from({ length: 100 }, (_, id) => ({
          ...row,
          id: id + 1,
          name: `engine-${id}`,
        })),
      },
    ],
    [listPath(2)]: [
      {
        body: [
          {
            ...row,
            id: 101,
            name: "special",
            owner: { login: "org" },
            private: false,
            archived: true,
            fork: true,
          },
        ],
      },
    ],
  });
  try {
    expect((await fixture.repositories.list(input, signal())).length).toBe(101);
    const selected = await fixture.repositories.list(
      {
        ...input,
        owner: "ORG",
        query: "SPECIAL",
        visibility: "public",
        archived: "yes",
        fork: "yes",
      },
      signal(),
    );
    expect(selected).toMatchObject([
      {
        id: 101,
        repository: { owner: "org", name: "special" },
        cloneUrl: "https://github.com/org/special.git",
        raw: { future: { enabled: true } },
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});
test("selected API account cannot borrow another identity's repository results", async () => {
  const fixture = await setup({ [listPath(1)]: [{ body: [row] }] });
  try {
    await expect(
      fixture.repositories.list({ ...input, account: "other" }, signal()),
    ).rejects.toMatchObject({ kind: "forbidden" });
  } finally {
    await fixture.cleanup();
  }
});
test("repository creation respects explicit ownership description and private visibility", async () => {
  const fixture = await setup({
    "orgs/org/repos": [
      { body: { ...row, owner: { login: "org" }, description: "Team project", private: true } },
    ],
  });
  try {
    const made = await fixture.repositories.create(
      {
        ...input,
        owner: "org",
        name: "engine",
        description: "Team project",
        visibility: "private",
      },
      signal(),
    );
    expect(made).toMatchObject({
      repository: { owner: "org", name: "engine" },
      description: "Team project",
      visibility: "private",
    });
    // These are process-boundary effects: ensure explicit creation cannot initialize unwanted commits.
    expect((await fixture.requests())[0]?.body).toEqual({
      name: "engine",
      description: "Team project",
      private: true,
      auto_init: false,
    });
  } finally {
    await fixture.cleanup();
  }
});
test("malformed repository data and cancelled discovery never produce selectable results", async () => {
  const fixture = await setup({ [listPath(1)]: [{ body: [{ ...row, id: "wrong" }] }] });
  try {
    await expect(fixture.repositories.list(input, signal())).rejects.toMatchObject({
      kind: "invalid_data",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(fixture.repositories.list(input, controller.signal)).rejects.toMatchObject({
      kind: "cancelled",
    });
  } finally {
    await fixture.cleanup();
  }
});
