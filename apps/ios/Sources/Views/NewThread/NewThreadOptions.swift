import SwiftUI

/// Effort, speed and access for the first turn of the chosen model and agent, each as its
/// choices in words: only levels and speeds the model lists and modes the agent supports
/// (`newThreadAccess` in `@ace/ui-core`). What the chosen access does is said under it, so the
/// riskier modes read as riskier by their words, not by colour.
struct NewThreadOptions: View {
    let compose: ComposeModel
    let drafts: NewThreadDraftModel
    let choice: NewThreadChoice
    private var access: ComposeAccess? { compose.access?.provider == choice.agent?.provider ? compose.access : nil }

    var body: some View {
        if let model = choice.model {
            let speeds = model.speeds ?? []
            ModelOptionsSection {
                if model.efforts.count > 1 {
                    OptionChoiceRow(title: "Effort", items: model.efforts.map { GlassChoiceItem(id: $0.id, label: $0.label) },
                                    selection: choice.effort, idPrefix: "newThread.effort") { effort in pick(model) { $0.effort = effort } }
                }
                if speeds.count > 1 {
                    OptionChoiceRow(title: "Speed", items: speeds.map { GlassChoiceItem(id: $0.speed, label: $0.label) },
                                    selection: drafts.draft.speed ?? model.defaultSpeed ?? "standard",
                                    idPrefix: "newThread.speed") { speed in pick(model) { $0.speed = speed } }
                }
                accessRow
            } footer: { EmptyView() }
        }
    }

    @ViewBuilder private var accessRow: some View {
        if let access {
            if access.state == "loading", access.choices.isEmpty {
                InsetRow(systemImage: nil, title: "Access") { ProgressView() }
            } else if !access.choices.isEmpty {
                OptionChoiceRow(title: "Access", items: access.choices.map { GlassChoiceItem(id: $0.mode, label: $0.label) },
                                selection: access.selected, note: accessNote(access), idPrefix: "newThread.access") { mode in
                    drafts.edit { $0.access = mode }
                }
            }
        }
    }
    /// What the chosen mode does, then why it runs stricter than asked or why Send waits.
    private func accessNote(_ access: ComposeAccess) -> String? {
        let shown = access.choices.first { $0.mode == access.selected }?.description
        let notes = [shown, access.problem ?? access.stricter].compactMap { $0 }.filter { !$0.isEmpty }
        return notes.isEmpty ? nil : notes.joined(separator: " ")
    }
    /// A tuning pick makes the suggested agent and model the draft's own.
    private func pick(_ model: ComposeAgent.Model, _ change: @escaping (inout NewThreadDraft) -> Void) {
        drafts.edit { draft in
            draft.provider = choice.agent?.provider; draft.model = model.key; draft.account = model.account
            change(&draft)
        }
    }
}
