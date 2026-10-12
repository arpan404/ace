import type { ForgeLocalStack, ForgeStackExpected } from "@ace/protocol/forge-stacks";
import { sha, nextSha } from "./identities.ts";
export const stackUuid = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
export const thirdSha = "c".repeat(40);
export const stackLayers = [
  {
    number: 7,
    position: 1,
    title: "Model",
    url: "https://github.com/octo/ace/pull/7",
    headRefOid: sha,
    headRefName: "model",
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: { state: "SUCCESS" },
    mergeQueueEntry: null,
  },
  {
    number: 8,
    position: 2,
    title: "API",
    url: "https://github.com/octo/ace/pull/8",
    headRefOid: nextSha,
    headRefName: "api",
    baseRefName: "model",
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: { state: "SUCCESS" },
    mergeQueueEntry: null,
  },
  {
    number: 9,
    position: 3,
    title: "UI",
    url: "https://github.com/octo/ace/pull/9",
    headRefOid: thirdSha,
    headRefName: "ui",
    baseRefName: "api",
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "BEHIND",
    reviewDecision: "APPROVED",
    statusCheckRollup: { state: "PENDING" },
    mergeQueueEntry: null,
  },
];
export function stackResponse(
  number = 8,
  layers: unknown[] = stackLayers.map((pr) => ({ position: pr.position, pullRequest: pr })),
) {
  return {
    body: {
      data: {
        repository: {
          viewerPermission: "WRITE",
          pullRequest: {
            number,
            stack: {
              id: "STACK_42",
              number: 42,
              baseRefName: "main",
              size: layers.length,
              entries: { nodes: layers, pageInfo: { hasNextPage: false } },
              future_field: "retained",
            },
          },
        },
      },
    },
  };
}
export const localStack: ForgeLocalStack = {
  trunk: "main",
  currentBranch: "ui",
  branches: [
    {
      name: "model",
      head: sha,
      base: "d".repeat(40),
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
      pr: { number: 7, url: "https://github.com/octo/ace/pull/7", state: "OPEN" },
    },
    {
      name: "api",
      head: nextSha,
      base: sha,
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: true,
      pr: { number: 8, url: "https://github.com/octo/ace/pull/8", state: "OPEN" },
    },
    {
      name: "ui",
      head: thirdSha,
      base: nextSha,
      isCurrent: true,
      isMerged: false,
      isQueued: false,
      needsRebase: true,
      pr: { number: 9, url: "https://github.com/octo/ace/pull/9", state: "OPEN" },
    },
  ],
};
export const expectedStack: ForgeStackExpected = {
  id: "STACK_42",
  trunk: "main",
  layers: [
    { number: 7, headSha: sha },
    { number: 8, headSha: nextSha },
    { number: 9, headSha: thirdSha },
  ],
  local: localStack,
};
export const stackChecksFixture = {
  "stack-checks": [
    {
      body: {
        data: {
          repository: {
            pr7: {
              headRefOid: sha,
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      kind: "CheckRun",
                      name: "Model tests",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      isRequired: true,
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
            pr8: {
              headRefOid: nextSha,
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      kind: "StatusContext",
                      context: "API tests",
                      state: "SUCCESS",
                      isRequired: true,
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
            pr9: {
              headRefOid: thirdSha,
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      kind: "CheckRun",
                      name: "UI tests",
                      status: "IN_PROGRESS",
                      conclusion: null,
                      isRequired: true,
                    },
                  ],
                  pageInfo: { hasNextPage: true },
                },
              },
            },
          },
        },
      },
    },
  ],
};
