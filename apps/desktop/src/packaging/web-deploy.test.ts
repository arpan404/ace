import { describe, expect, it } from "vitest";
import { webDeployPlan, type WebDeployFacts } from "./web-deploy.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";
const facts = (overrides: Partial<WebDeployFacts>): WebDeployFacts => ({
  tag: "v0.0.24",
  commit,
  published: ["v0.0.23", "ace-0.0.24-beta-1"],
  ...overrides,
});
const deployed = (plan: ReturnType<typeof webDeployPlan>) => plan.deploy.map((b) => b.branch);
const skipped = (plan: ReturnType<typeof webDeployPlan>) => plan.skip.map((b) => b.branch);

describe("a stable release's web app", () => {
  it("goes to app.acehq.dev and to the beta site, stamped with the release's version", () => {
    expect(webDeployPlan(facts({}))).toEqual({
      version: "0.0.24",
      message: "ace v0.0.24",
      deploy: [
        { branch: "main", site: "https://app.acehq.dev" },
        { branch: "beta", site: "https://beta.app.acehq.dev" },
      ],
      skip: [],
    });
  });

  it("goes to neither site when a later stable release is already out", () => {
    const plan = webDeployPlan(facts({ published: ["v0.0.25", "v0.0.23"] }));
    expect(plan.deploy).toEqual([]);
    expect(plan.skip).toEqual([
      { branch: "main", reason: expect.stringMatching(/0\.0\.25 is already published/) },
      { branch: "beta", reason: expect.stringMatching(/0\.0\.25 is already published/) },
    ]);
  });

  it("still reaches app.acehq.dev when a later beta holds the beta site", () => {
    const plan = webDeployPlan(facts({ published: ["v0.0.23", "ace-0.0.25-beta-2"] }));
    expect(deployed(plan)).toEqual(["main"]);
    expect(plan.skip).toEqual([
      { branch: "beta", reason: expect.stringMatching(/0\.0\.25-beta\.2/) },
    ]);
  });

  it("replaces its own betas on the beta site", () => {
    const plan = webDeployPlan(facts({ published: ["ace-0.0.24-beta-9"] }));
    expect(deployed(plan)).toEqual(["main", "beta"]);
  });

  it("orders versions numerically, not as text", () => {
    expect(deployed(webDeployPlan(facts({ tag: "v0.0.10", published: ["v0.0.9"] })))).toEqual([
      "main",
      "beta",
    ]);
    expect(skipped(webDeployPlan(facts({ tag: "v0.0.9", published: ["v0.0.10"] })))).toEqual([
      "main",
      "beta",
    ]);
  });
});

describe("a beta's web app", () => {
  it("goes to the beta site only, with the beta's app version", () => {
    expect(webDeployPlan(facts({ tag: "ace-0.0.25-beta-2", published: ["v0.0.24"] }))).toEqual({
      version: "0.0.25-beta.2",
      message: "ace ace-0.0.25-beta-2",
      deploy: [{ branch: "beta", site: "https://beta.app.acehq.dev" }],
      skip: [],
    });
  });

  it("isn't deployed over a later beta that is already out", () => {
    const plan = webDeployPlan(
      facts({ tag: "ace-0.0.25-beta-2", published: ["ace-0.0.25-beta-10"] }),
    );
    expect(plan.deploy).toEqual([]);
    expect(plan.skip).toEqual([
      { branch: "beta", reason: expect.stringMatching(/0\.0\.25-beta\.10/) },
    ]);
  });

  it("isn't deployed over the stable release it previewed, once that is out", () => {
    const plan = webDeployPlan(facts({ tag: "ace-0.0.25-beta-2", published: ["v0.0.25"] }));
    expect(deployed(plan)).toEqual([]);
    expect(skipped(plan)).toEqual(["beta"]);
  });
});

it("ignores published tags that aren't releases", () => {
  const plan = webDeployPlan(facts({ published: ["v9.9", "nightly", "v0.0.99-rc.1"] }));
  expect(deployed(plan)).toEqual(["main", "beta"]);
});

it("refuses a tag that isn't a release tag, or a commit that isn't a full sha", () => {
  expect(() => webDeployPlan(facts({ tag: "main" }))).toThrow(/neither/);
  expect(() => webDeployPlan(facts({ tag: "v0.0.24-rc.1" }))).toThrow(/neither/);
  expect(() => webDeployPlan(facts({ commit: "0123456" }))).toThrow(/full commit sha/);
});
