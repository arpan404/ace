import SwiftUI

/// A native subagent pushed in a navigation stack: the transcript's lane and the Agents sheet
/// both open one, and a subagent's own subagents push on top.
struct SubagentRoute: Hashable, Identifiable {
    let agentId: String
    let title: String
    var id: String { agentId }
}

/// A provider's own subagent as the whole page, as the web's subagent view: what its parent asked
/// (the person's bubble), its own blocks grouped as the transcript is, then in the composer's
/// place its requests and a status bar: who runs it, how its whole branch stands, Stop while it
/// runs and Ask parent to retry once it failed or was stopped. Every word and rule is the bridge's
/// (`subagentInspection`); the branch never reads done while anything under it works or waits.
struct SubagentView: View {
    let route: SubagentRoute
    let model: ClientModel
    let thread: ThreadModel
    /// A subagent of this one that runs in its own lane.
    let push: (SubagentRoute) -> Void
    /// A child that runs as its own ace thread: leaves the sheet and opens it.
    let openThread: (String) -> Void
    @State private var questionDraft = QuestionDraftState()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var lane: LaneModel? { thread.screen.lane?.agentId == route.agentId ? thread.screen.lane : nil }
    private var info: SubagentInfo? { lane?.info }
    /// The oldest request waiting on the person from this subagent or anything under it.
    private var request: ApprovalRow? {
        info?.requests.lazy.compactMap { thread.interactions[$0] }.first { $0.state == "pending" }
    }

    var body: some View {
        List {
            if let prompt = info?.prompt {
                PromptBubble(prompt: prompt, parent: info?.parent.name ?? "")
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                    .transition(.opacity)
            }
            if let lane, !lane.order.isEmpty {
                let links = TranscriptLinks(openThread: openThread,
                                            openAgent: { push(SubagentRoute(agentId: $0.agentId, title: $0.title)) })
                ForEach(lane.order, id: \.self) { id in
                    if let block = lane.blocks[id] {
                        BlockView(block: block, thread: thread, links: links)
                            .listRowSeparator(.hidden).listRowBackground(Color.clear)
                    }
                }
            } else if lane?.missing == true {
                EmptyState(icon: .graph, title: "This subagent isn't in the loaded thread",
                           line: "It may belong to older history that hasn't loaded yet.") { EmptyView() }
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
            } else if info != nil {
                Text("Nothing from this subagent yet.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AceTheme.Colours.background)
        .overlay {
            // Reserved room, not a spinner that pushes rows: the page fills in place.
            if info == nil && lane?.missing != true && (lane?.order.isEmpty ?? true) {
                ProgressView().accessibilityLabel("Loading subagent").transition(.opacity)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { bottom }
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .smooth, value: info)
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .smooth, value: lane?.order.count)
        .accessibilityIdentifier("lane.transcript")
        .navigationTitle(info?.name ?? route.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: AceTheme.Spacing.xxs) {
                    Text(info?.name ?? route.title).aceFont(AceTheme.Typography.title, relativeTo: .headline).lineLimit(1)
                    if let parent = info?.parent.name, !parent.isEmpty {
                        Text("Started by \(parent)").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .onAppear { model.openLane(route.agentId) }
        .onDisappear { model.closeLane(route.agentId, epoch: thread.epoch) }
        .onChange(of: request?.id) { _, _ in questionDraft = QuestionDraftState() }
    }

    /// Its requests in the composer's one strip, then the status bar, on the composer's glass.
    @ViewBuilder private var bottom: some View {
        if let info {
            VStack(spacing: AceTheme.Spacing.none) {
                if let request {
                    StripSurface(maxHeight: 360) {
                        RequestCard(request: request, model: model, maxHeight: 320, questionDraft: $questionDraft, openBrowser: {})
                    }
                    .transition(.opacity)
                }
                SubagentStatusBar(info: info, model: model)
            }
            .composerGlassGroup()
            .animation(reduceMotion ? nil : .smooth, value: request?.id)
            .transition(.opacity)
        }
    }
}

/// What the parent asked, where a thread starts with the person's message: the bubble folds a
/// long prompt as the person's long messages do.
private struct PromptBubble: View {
    let prompt: SubagentInfo.Prompt
    let parent: String
    var body: some View {
        VStack(alignment: .trailing, spacing: AceTheme.Spacing.xs) {
            UserBubble(text: prompt.bubble.segments.map(\.text).joined(), bubble: prompt.bubble, id: "prompt")
            Text(Date(timeIntervalSince1970: prompt.at / 1000), format: .dateTime.hour().minute())
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.vertical, AceTheme.Spacing.sm)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(parent.isEmpty ? "Prompt" : "Asked by \(parent)")
        .accessibilityIdentifier("subagent.prompt")
    }
}
