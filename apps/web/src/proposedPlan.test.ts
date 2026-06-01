import { describe, expect, it } from "vitest";

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
  stripDisplayedPlanMarkdown,
} from "./proposedPlan";

describe("proposedPlanTitle", () => {
  it("reads the first markdown heading as the plan title", () => {
    expect(proposedPlanTitle("# Integrate RPC\n\nBody")).toBe("Integrate RPC");
  });

  it("normalizes provider plan markers before reading the title", () => {
    expect(
      proposedPlanTitle("<!--ACE_PROPOSED_PLAN_START\n>#Proposed Plan\n\n1.Define SLOs."),
    ).toBe("Proposed Plan");
  });

  it("uses the actual title for compact Pi plan headings", () => {
    expect(proposedPlanTitle("ProposedPlan: ImproveRobustnessandScalabilityforAce1. Audit")).toBe(
      "Improve Robustness and Scalability for Ace",
    );
  });

  it("returns null when the plan has no heading", () => {
    expect(proposedPlanTitle("- step 1")).toBeNull();
  });
});

describe("buildPlanImplementationPrompt", () => {
  it("formats the plan exactly like the Codex follow-up handoff prompt", () => {
    expect(buildPlanImplementationPrompt("## Ship it\n\n- step 1\n")).toBe(
      "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
    );
  });

  it("repairs compact Pi plan markdown before handoff", () => {
    expect(buildPlanImplementationPrompt("ProposedPlan: ImproveAce1. Defineobservability.")).toBe(
      "PLEASE IMPLEMENT THIS PLAN:\n# Proposed Plan: Improve Ace\n\n1. Define observability.",
    );
  });
});

describe("normalizePlanMarkdownForExport", () => {
  it("exports repaired markdown for compact Pi plans", () => {
    expect(normalizePlanMarkdownForExport("ProposedPlan: ImproveAce1. Defineobservability.")).toBe(
      "# Proposed Plan: Improve Ace\n\n1. Define observability.\n",
    );
  });
});

describe("buildCollapsedProposedPlanPreviewMarkdown", () => {
  it("drops the redundant title heading and preserves the following markdown lines", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown(
        "# Integrate RPC\n\n## Summary\n\n- step 1\n- step 2",
        {
          maxLines: 4,
        },
      ),
    ).toBe("- step 1\n- step 2");
  });

  it("appends an overflow marker when the preview truncates remaining content", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown("# Integrate RPC\n\n- step 1\n- step 2\n- step 3", {
        maxLines: 2,
      }),
    ).toBe("- step 1\n- step 2\n\n...");
  });
});

describe("stripDisplayedPlanMarkdown", () => {
  it("drops the leading title heading from displayed plan markdown", () => {
    expect(stripDisplayedPlanMarkdown("# Integrate RPC\n\n## Summary\n\n- step 1\n")).toBe(
      "- step 1",
    );
  });

  it("preserves non-summary headings after dropping the title heading", () => {
    expect(stripDisplayedPlanMarkdown("# Integrate RPC\n\n## Scope\n\n- step 1\n")).toBe(
      "## Scope\n\n- step 1",
    );
  });

  it("removes provider plan markers and repairs compact markdown spacing for display", () => {
    expect(
      stripDisplayedPlanMarkdown(
        "<!--ACE_PROPOSED_PLAN_START\n>#Proposed Plan\n\n1.Define SLOs.\n2.Add observability.\n<!--ACE_PROPOSED_PLAN_END",
      ),
    ).toBe("1. Define SLOs.\n\n2. Add observability.");
  });

  it("keeps a compact heading-only plan visible when expanded", () => {
    expect(
      stripDisplayedPlanMarkdown(
        "<!--ACE_PROPOSED_PLAN_START\n>#Implementation plan: Gather baselines. 1. Define SLOs. 2. Add observability.",
      ),
    ).toBe("1. Define SLOs.\n\n2. Add observability.");
  });

  it("repairs Pi compact prose into readable markdown sections and bullets", () => {
    expect(
      stripDisplayedPlanMarkdown(
        "ProposedPlan: ImproveRobustnessandScalabilityforAce1. Auditcurrentarchitectureandbottlenecks-Inventoryservices(apps/server, apps/web, packages)andexternaldependencies(codexapp-server, DBs, caches).-Collectruntimemetrics, logs, andincidenthistoryforthelast3months.-Runloadprofilescenarios(startup, bursttraffic, long-runningsessions)andrecordresourceusageandfailuremodes.2. Hardenprovidersessionlifecycle(codexapp-server)-Addrobuststart/stop/retrylogicforcodexapp-serverprocesseswithexponentialbackoffandjitter.",
      ),
    ).toBe(
      [
        "1. Audit current architecture and bottlenecks",
        "   - Inventory services (apps/server, apps/web, packages) and external dependencies (codex app-server, DBs, caches).",
        "   - Collect runtime metrics, logs, and incident history for the last 3 months.",
        "   - Run load profile scenarios (startup, burst traffic, long-running sessions) and record resource usage and failure modes.",
        "",
        "2. Harden provider session lifecycle (codex app-server)",
        "   - Add robust start/stop/retry logic for codex app-server processes with exponential backoff and jitter.",
      ].join("\n"),
    );
  });

  it("repairs longer Pi compact prose without swallowing later numbered sections", () => {
    expect(
      stripDisplayedPlanMarkdown(
        "ProposedPlan: ImproveRobustnessandScalabilityforAce1. Auditcurrentarchitectureandbottlenecks-Inventoryservices(apps/server, apps/web, packages)andexternaldependencies(codexapp-server, DBs, caches).-Collectruntimemetrics, logs, andincidenthistoryforthelast3months.-Runloadprofilescenarios(startup, bursttraffic, long-runningsessions)andrecordresourceusageandfailuremodes.2. Hardenprovidersessionlifecycle(codexapp-server)-Addrobuststart/stop/retrylogicforcodexapp-serverprocesseswithexponentialbackoffandjitter.-Implementdeterministicsessiontimeoutsandgracefulshutdownhandlers.-Persistminimalsessionstatetoallowsaferesumeaftercrashorrestart.-Addcircuitbreakeraroundprovidercommunicationstoavoidcascadingfailureswhenproviderissloworunavailable.3. Improveorchestrationandeventreliability-Usedurableeventqueueorpersistencefororchestration.domainEventmessages(e.g., RedisStreams, Kafka, orpersistentDBtable).-Ensureat-least-oncedeliverysemanticswithidempotenthandlersordeduplicationtokens.-Addmonitoring/alertsforeventbacklog, processinglatency, anddroppedevents.4. MakeWebSocketlayerresilient-Implementheartbeat/pingandreconnectionstrategiesonbothclientandserver.-Supportstickysessionsorsessionreattachmentssoclientscanreconnecttothesameprovidersessionwithoutlosingstate.-Rate-limitandprotectWebSocketendpointsagainstnoisyclients.5. Scalehorizontallyandaddautoscaling-Containerizeservices(ifnotalready)andprepareformulti-instancedeployment.-Makeserverstatelesswherepossible: movesessionmetadataandephemeralstatetoexternalstores(Redis, DB).-Addautoscalingpolicies(CPU, memory, requestlatency, queuedepth)andhealthchecks.6. Optimizeresourceusageandconcurrencymodel-Reviewcodexapp-serverper-sessionmodel; considermultiplexingmultiplelightweightsessionsperprocessorpoolingprovidersifprotocolallows.-Limitconcurrentprovideroperationspermachineandimplementbackpressureatadmissionpoints.",
      ),
    ).toContain(
      [
        "4. Make WebSocket layer resilient",
        "   - Implement heartbeat/ping and reconnection strategies on both client and server.",
        "   - Support sticky sessions or session reattachments so clients can reconnect to the same provider session without losing state.",
        "   - Rate-limit and protect WebSocket endpoints against noisy clients.",
        "",
        "5. Scale horizontally and add autoscaling",
      ].join("\n"),
    );
  });
});

describe("resolvePlanFollowUpSubmission", () => {
  it("switches to default mode when implementing the ready plan without extra text", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "   ",
        planMarkdown: "## Ship it\n\n- step 1\n",
      }),
    ).toEqual({
      text: "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
      interactionMode: "default",
    });
  });

  it("stays in plan mode when the user adds a follow-up prompt", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "Refine step 2 first",
        planMarkdown: "## Ship it\n\n- step 1\n",
      }),
    ).toEqual({
      text: "Refine step 2 first",
      interactionMode: "plan",
    });
  });
});

describe("buildPlanImplementationThreadTitle", () => {
  it("uses the plan heading when building the implementation thread title", () => {
    expect(buildPlanImplementationThreadTitle("# Integrate RPC\n\nBody")).toBe(
      "Implement Integrate RPC",
    );
  });

  it("falls back when the plan has no markdown heading", () => {
    expect(buildPlanImplementationThreadTitle("- step 1")).toBe("Implement plan");
  });
});

describe("buildProposedPlanMarkdownFilename", () => {
  it("derives a stable markdown filename from the plan heading", () => {
    expect(buildProposedPlanMarkdownFilename("# Integrate Effect RPC Into Server App")).toBe(
      "integrate-effect-rpc-into-server-app.md",
    );
  });

  it("falls back to a generic filename when the plan has no heading", () => {
    expect(buildProposedPlanMarkdownFilename("- step 1")).toBe("plan.md");
  });
});
