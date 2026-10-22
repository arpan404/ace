import SwiftUI

/// New thread's model sheet: the machine's coding agents and their models, grouped by agent,
/// then effort, speed and access for the first turn. One that isn't installed, is signed out or
/// needs attention stays listed with the reason the bridge gave. Each agent leads with the model
/// in use (else its default); the rest of a long list waits behind "More models", in the order the
/// bridge sent (`newThreadModelList` in `@ace/ui-core/mobile`). Picks edit the draft as they're
/// made; X puts the draft back as it was.
struct NewThreadModelSheet: View {
    @Bindable var compose: ComposeModel
    let drafts: NewThreadDraftModel
    let reload: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var expanded: Set<String> = []
    @State private var snapshot: NewThreadChoice.Snapshot?
    private var draft: NewThreadDraft { drafts.draft }
    private var choice: NewThreadChoice { NewThreadChoice(compose: compose, draft: draft) }

    var body: some View {
        ModelSheet(query: $query, cancel: restore, confirm: { dismiss() }) {
            switch compose.agentsState {
            case "ready":
                ForEach(compose.agents) { agent in agentSection(agent) }
                if query.isEmpty { NewThreadOptions(compose: compose, drafts: drafts, choice: choice) }
            case "failed":
                ContentUnavailableView {
                    Label("Couldn't read coding agents", systemImage: "wifi.exclamationmark")
                } description: { Text("Your computer didn't answer.") } actions: { Button("Try again", action: reload) }
            default:
                HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
            }
        }
        .onAppear { if snapshot == nil { snapshot = .init(draft) } }
    }
    private func restore() {
        guard let snapshot else { return }
        drafts.edit { snapshot.restore(&$0) }
    }

    @ViewBuilder private func agentSection(_ agent: ComposeAgent) -> some View {
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let models = (searching || expanded.contains(agent.provider) ? Array(agent.models) : Array(agent.leading))
            .filter { ModelSearch.matches(query, $0.label, agent.name) }
        if !searching || !models.isEmpty {
            Section {
                if agent.ready {
                    ForEach(models) { model in row(agent, model) }
                    if !searching && !agent.more.isEmpty { more(agent) }
                } else {
                    Text(agent.reason ?? "Not ready").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .accessibilityIdentifier("agent.\(agent.provider).reason")
                }
            } header: {
                HStack {
                    InsetHeader(agent.name)
                    Spacer()
                    if !agent.ready { StateLabel(status: agent.status) }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("agent.\(agent.provider)")
            }
            .insetRowBackground()
        }
    }
    private func row(_ agent: ComposeAgent, _ model: ComposeAgent.Model) -> some View {
        let chosen = choice.agent?.provider == agent.provider && choice.model?.key == model.key && choice.model?.account == model.account
        let account = agent.accounts.count > 1 ? agent.accounts.first { $0.id == model.account } : nil
        return ModelChoiceRow(provider: agent.provider, label: model.label, detail: account.map { "\($0.label) · \($0.usage)" }, chosen: chosen) {
            drafts.edit { $0.provider = agent.provider; $0.model = model.key; $0.account = model.account; $0.effort = nil; $0.speed = nil }
        }
        .accessibilityIdentifier("model.\(agent.provider).\(model.label)")
    }
    @ViewBuilder private func more(_ agent: ComposeAgent) -> some View {
        let open = expanded.contains(agent.provider)
        Button {
            if open { expanded.remove(agent.provider) } else { expanded.insert(agent.provider) }
        } label: {
            InsetRow(icon: nil, title: open ? "Fewer models" : "More models") {
                if !open { InsetValue(text: "\(agent.more.count)") }
                Image(systemName: open ? "chevron.up" : "chevron.down").foregroundStyle(AceTheme.Colours.decoration).accessibilityHidden(true)
            }
        }
        .buttonStyle(.plain)
        .accessibilityValue(open ? "" : "\(agent.more.count) more")
        .accessibilityIdentifier("agent.\(agent.provider).\(open ? "fewer" : "more")")
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
            Section {
                if model.efforts.count > 1 {
                    ModelOptionMenu(icon: .lightbulb, title: "Effort", value: model.efforts.first { $0.id == choice.effort }?.label ?? "Default") {
                        Picker("Effort", selection: Binding(get: { choice.effort ?? "" }, set: { effort in pick(model) { $0.effort = effort } })) {
                            ForEach(model.efforts) { Text($0.label).tag($0.id) }
                        }
                    }
                    .accessibilityIdentifier("newThread.effort")
                }
                speedRow(model, speeds: speeds)
                accessRow
            } header: { InsetHeader("Options") } footer: { footer }
            .insetRowBackground()
        }
    }
    @ViewBuilder private func speedRow(_ model: ComposeAgent.Model, speeds: [ComposeAgent.Speed]) -> some View {
        let current = drafts.draft.speed ?? model.defaultSpeed ?? "standard"
        if speeds.count == 2, speeds.contains(where: { $0.speed == "standard" }), let fast = speeds.first(where: { $0.speed != "standard" }) {
            FastModeRow(on: current == fast.speed) { on in pick(model) { $0.speed = on ? fast.speed : "standard" } }
                .accessibilityIdentifier("newThread.speed")
        } else if speeds.count > 1 {
            ModelOptionMenu(icon: .lightning, title: "Speed", value: speeds.first { $0.speed == current }?.label ?? "") {
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
                InsetRow(icon: .shieldCheck, title: "Access") { ProgressView() }
            } else if !access.choices.isEmpty {
                ModelOptionMenu(icon: .shieldCheck, title: "Access", value: access.choices.first { $0.mode == access.selected }?.label ?? "") {
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
