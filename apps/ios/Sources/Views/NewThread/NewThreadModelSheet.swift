import SwiftUI

/// New thread's model sheet: the computer's coding agents as a row of providers, the shown one's
/// models below, then effort, speed and access for the first turn. It opens on the draft's agent
/// with its model checked. One that is signed out or needs attention says why in one line; one
/// that isn't installed isn't listed (`newThreadPickerAgents`). A long list keeps its rest behind
/// "More models", in the bridge's order (`newThreadModelList`). Picks edit the draft as they're
/// made; X puts the draft back as it was.
struct NewThreadModelSheet: View {
    @Bindable var compose: ComposeModel
    let drafts: NewThreadDraftModel
    let reload: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var expanded: Set<String> = []
    @State private var shown = ""
    @State private var snapshot: NewThreadChoice.Snapshot?
    private var draft: NewThreadDraft { drafts.draft }
    private var choice: NewThreadChoice { NewThreadChoice(compose: compose, draft: draft) }
    private var agent: ComposeAgent? { compose.agents.first { $0.provider == shown } }
    private var state: ModelPickerState {
        switch compose.agentsState {
        case "ready": .ready
        case "failed": .failed(title: "Couldn't read coding agents", message: "Your computer didn't answer.")
        default: .loading
        }
    }
    private var chosen: NewThreadPickerRows.Chosen? {
        guard let agent = choice.agent, let model = choice.model else { return nil }
        return .init(provider: agent.provider, key: model.key, account: model.account)
    }

    var body: some View {
        let open = expanded.contains(shown)
        ModelPicker(
            query: $query,
            providers: compose.agents.map { ModelPickerProvider(id: $0.provider, name: $0.name, note: $0.ready ? nil : ($0.reason ?? "Not ready")) },
            shown: $shown, state: state,
            groups: agent.map { NewThreadPickerRows.groups($0, chosen: chosen, query: query, expanded: open) } ?? [],
            hidden: agent.map { NewThreadPickerRows.hidden($0, query: query, expanded: open) } ?? 0,
            expanded: open && (agent?.more.isEmpty == false) && query.isEmpty,
            toggleMore: { if open { expanded.remove(shown) } else { expanded.insert(shown) } },
            rowPrefix: "model.\(shown)", morePrefix: "agent.\(shown)",
            retry: reload, cancel: restore, confirm: { dismiss() }, choose: pick
        ) {
            if choice.agent?.provider == shown { NewThreadOptions(compose: compose, drafts: drafts, choice: choice) }
        }
        .onAppear {
            if snapshot == nil { snapshot = .init(draft) }
            if shown.isEmpty { shown = choice.agent?.provider ?? compose.agents.first?.provider ?? "" }
        }
        .onChange(of: compose.agents.map(\.provider)) { _, providers in
            if !providers.contains(shown) { shown = choice.agent?.provider ?? providers.first ?? "" }
        }
    }
    private func pick(_ row: ModelPickerRow) {
        guard let agent, let model = agent.models.first(where: { $0.id == row.id }) else { return }
        drafts.edit { $0.provider = agent.provider; $0.model = model.key; $0.account = model.account; $0.effort = nil; $0.speed = nil }
    }
    private func restore() {
        guard let snapshot else { return }
        drafts.edit { snapshot.restore(&$0) }
    }
}

/// Effort, speed and access for the first turn of the chosen model and agent: only levels and
/// speeds the model lists and modes the agent supports (`newThreadAccess` in `@ace/ui-core`).
private struct NewThreadOptions: View {
    let compose: ComposeModel
    let drafts: NewThreadDraftModel
    let choice: NewThreadChoice
    private var access: ComposeAccess? { compose.access?.provider == choice.agent?.provider ? compose.access : nil }

    var body: some View {
        if let model = choice.model {
            let speeds = model.speeds ?? []
            ModelOptionsSection {
                if model.efforts.count > 1 {
                    ModelOptionMenu(title: "Effort", value: model.efforts.first { $0.id == choice.effort }?.label ?? "Default") {
                        Picker("Effort", selection: Binding(get: { choice.effort ?? "" }, set: { effort in pick(model) { $0.effort = effort } })) {
                            ForEach(model.efforts) { Text($0.label).tag($0.id) }
                        }
                    }
                    .accessibilityIdentifier("newThread.effort")
                }
                speedRow(model, speeds: speeds)
                accessRow
            } footer: { footer }
        }
    }
    @ViewBuilder private func speedRow(_ model: ComposeAgent.Model, speeds: [ComposeAgent.Speed]) -> some View {
        let current = drafts.draft.speed ?? model.defaultSpeed ?? "standard"
        if speeds.count == 2, speeds.contains(where: { $0.speed == "standard" }), let fast = speeds.first(where: { $0.speed != "standard" }) {
            FastModeRow(on: current == fast.speed) { on in pick(model) { $0.speed = on ? fast.speed : "standard" } }
                .accessibilityIdentifier("newThread.speed")
        } else if speeds.count > 1 {
            ModelOptionMenu(title: "Speed", value: speeds.first { $0.speed == current }?.label ?? "") {
                Picker("Speed", selection: Binding(get: { current }, set: { speed in pick(model) { $0.speed = speed } })) {
                    ForEach(speeds) { Text($0.label).tag($0.speed) }
                }
            }
            .accessibilityIdentifier("newThread.speed")
        }
    }
    @ViewBuilder private var accessRow: some View {
        if let access {
            if access.state == "loading", access.choices.isEmpty {
                InsetRow(systemImage: nil, title: "Access") { ProgressView() }
            } else if !access.choices.isEmpty {
                ModelOptionMenu(title: "Access", value: access.choices.first { $0.mode == access.selected }?.label ?? "") {
                    Picker("Access", selection: Binding(get: { access.selected ?? "" }, set: { mode in drafts.edit { $0.access = mode } })) {
                        ForEach(access.choices) { choice in Text(choice.label).tag(choice.mode) }
                    }
                }
                .accessibilityIdentifier("newThread.access")
            }
        }
    }
    /// What the chosen access does, and why it runs stricter than asked, when it does.
    @ViewBuilder private var footer: some View {
        if let access {
            let shown = access.choices.first { $0.mode == access.selected }
            let note = access.problem ?? access.stricter
            if shown != nil || note != nil {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                    if let shown {
                        Text(shown.description).foregroundStyle(shown.attention ? AceTheme.StatusText.needsYou : AceTheme.Colours.mutedForeground)
                    }
                    if let note {
                        Text(note).foregroundStyle(access.problem == nil ? AceTheme.Colours.mutedForeground : AceTheme.StatusText.needsYou)
                            .accessibilityIdentifier("newThread.accessNote")
                    }
                }
            }
        }
    }
    /// A tuning pick makes the suggested agent and model the draft's own.
    private func pick(_ model: ComposeAgent.Model, _ change: @escaping (inout NewThreadDraft) -> Void) {
        drafts.edit { draft in
            draft.provider = choice.agent?.provider; draft.model = model.key; draft.account = model.account
            change(&draft)
        }
    }
}
