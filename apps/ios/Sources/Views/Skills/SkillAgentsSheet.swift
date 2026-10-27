import SwiftUI

/// Which agents see a skill. Switches are a draft until Done, which sends one change, so quick
/// taps can't overwrite each other. An agent that reads the skill's own folder, or keeps its own
/// copy, stays on and says why.
struct SkillAgentsSheet: View {
    let page: SkillPage
    let done: ([String]) -> Void
    @State private var draft: [SkillAgentChoice]
    @Environment(\.dismiss) private var dismiss

    init(page: SkillPage, done: @escaping ([String]) -> Void) {
        self.page = page
        self.done = done
        _draft = State(initialValue: page.agents)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    SkillAgentToggles(agents: $draft)
                } footer: {
                    if draft.contains(where: { $0.locked && $0.on }) {
                        Text("Agents that read the folder \(page.title) is saved in always see it.")
                    }
                }
                .insetRowBackground()
            }
            .insetGroupedList()
            .sensoryFeedback(.selection, trigger: draft)
            .navigationTitle("Agents").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { done(draft.filter(\.on).map(\.id)) }
                        .disabled(draft == page.agents)
                        .accessibilityIdentifier("skill.agents.done")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(draft != page.agents)
    }
}

/// One switch per agent, its mark beside its name. Locked agents stay on.
struct SkillAgentToggles: View {
    @Binding var agents: [SkillAgentChoice]
    var body: some View {
        ForEach($agents) { $agent in
            Toggle(isOn: $agent.on.animation(.smooth)) {
                HStack(spacing: AceTheme.Spacing.md) {
                    ProviderMark(provider: agent.id, size: 19)
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        Text(agent.name).aceFont(InsetStyle.label, relativeTo: .body)
                        if agent.locked && agent.on {
                            Text("Reads its folder").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                        }
                    }
                }
            }
            .disabled(agent.locked && agent.on)
            .frame(minHeight: AceTheme.Dimensions.touchTarget)
            .accessibilityIdentifier("skill.agent.\(agent.id)")
        }
    }
}
