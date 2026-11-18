import { describe, expect, it } from "vitest";
import { webDeployPlan, type WebDeployFacts } from "./web-deploy.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";
const facts = (overrides: Partial<WebDeployFacts>): WebDeployFacts => ({
  tag: "v0.0.24",
  commit,
  published: ["v0.0.23", "ace-0.0.24-beta-1"],
  ...overrides,
});

describe("a stable release's web app", () => {
  it("goes to app.acehq.dev, stamped with the release's version", () => {
    expect(webDeployPlan(facts({}))).toEqual({
      action: "deploy",
      version: "0.0.24",
      branch: "main",
      message: "ace v0.0.24",
      site: "https://app.acehq.dev",
    });
  });

  it("isn't deployed over a later stable release that is already out", () => {
    const plan = webDeployPlan(facts({ tag: "v0.0.24", published: ["v0.0.25", "v0.0.23"] }));
    expect(plan).toMatchObject({ action: "skip", reason: expect.stringMatching(/0\.0\.25/) });
  });

  it("is deployed even when a later beta is out, since betas never reach app.acehq.dev", () => {
    const plan = webDeployPlan(facts({ published: ["ace-0.0.25-beta-1", "ace-0.0.25-beta-2"] }));
    expect(plan).toMatchObject({ action: "deploy", branch: "main" });
  });

  it("orders versions numerically, not as text", () => {
    expect(webDeployPlan(facts({ tag: "v0.0.10", published: ["v0.0.9"] })).action).toBe("deploy");
    expect(webDeployPlan(facts({ tag: "v0.0.9", published: ["v0.0.10"] })).action).toBe("skip");
  });
});

describe("a beta's web app", () => {
  it("goes to the beta branch with the beta's app version, leaving app.acehq.dev alone", () => {
    expect(webDeployPlan(facts({ tag: "ace-0.0.25-beta-2", published: ["v0.0.24"] }))).toEqual({
      action: "deploy",
      version: "0.0.25-beta.2",
      branch: "beta",
      message: "ace ace-0.0.25-beta-2",
      site: "https://beta.ace-web.pages.dev",
    });
  });

  it("isn't deployed over a later beta that is already out", () => {
    const plan = webDeployPlan(
      facts({ tag: "ace-0.0.25-beta-2", published: ["ace-0.0.25-beta-10"] }),
    );
    expect(plan).toMatchObject({
      action: "skip",
      reason: expect.stringMatching(/0\.0\.25-beta\.10/),
    });
  });

  it("is deployed when only a later stable release is out", () => {
    const plan = webDeployPlan(facts({ tag: "ace-0.0.25-beta-2", published: ["v0.0.26"] }));
    expect(plan).toMatchObject({ action: "deploy", branch: "beta" });
  });
});

it("ignores published tags that aren't releases", () => {
  const plan = webDeployPlan(facts({ published: ["v9.9", "nightly", "v0.0.99-rc.1"] }));
  expect(plan.action).toBe("deploy");
});

it("refuses a tag that isn't a release tag, or a commit that isn't a full sha", () => {
  expect(() => webDeployPlan(facts({ tag: "main" }))).toThrow(/neither/);
  expect(() => webDeployPlan(facts({ tag: "v0.0.24-rc.1" }))).toThrow(/neither/);
  expect(() => webDeployPlan(facts({ commit: "0123456" }))).toThrow(/full commit sha/);
});
