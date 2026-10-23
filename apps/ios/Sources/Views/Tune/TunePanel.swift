import SwiftUI

/// The small sheet the composer's effort part opens: Effort and Speed as rows of their levels in
/// words, and a quiet line under them when there's something to say. It sits low (system glass on
/// iOS 26) and closes by swiping or tapping outside.
struct TunePanel<Rows: View, Footer: View>: View {
    /// How many option rows it shows; the panel is as tall as they need.
    let count: Int
    @ViewBuilder var rows: () -> Rows
    @ViewBuilder var footer: () -> Footer

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            rows()
            footer()
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, AceTheme.Spacing.xl)
        .padding(.top, AceTheme.Spacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.height(CGFloat(104 + 100 * max(1, count)))])
        .presentationDragIndicator(.visible)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tunePanel")
    }
}

/// The open thread's effort and speed for its next message, as the bridge offers them.
struct ThreadTunePanel: View {
    let tune: TuneRow
    let model: ClientModel

    var body: some View {
        TunePanel(count: (tune.efforts.isEmpty ? 0 : 1) + (tune.speeds.count > 1 ? 1 : 0)) {
            if !tune.efforts.isEmpty {
                OptionChoiceRow(title: "Effort", items: tune.efforts.map { GlassChoiceItem(id: $0.id, label: $0.label) },
                                selection: tune.effort, note: tune.effortReason.isEmpty ? nil : tune.effortReason,
                                disabled: !tune.effortReason.isEmpty, idPrefix: "composer.tune") { effort in
                    Task { _ = await model.setEffort(effort) }
                }
            }
            if tune.speeds.count > 1 {
                OptionChoiceRow(title: "Speed", items: tune.speeds.map { GlassChoiceItem(id: $0.speed, label: $0.label) },
                                selection: tune.speed, note: tune.speedReason.isEmpty ? nil : tune.speedReason,
                                disabled: !tune.speedReason.isEmpty, idPrefix: "composer.speed") { speed in
                    Task { _ = await model.setSpeed(speed) }
                }
            }
        } footer: {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                if tune.pending { Text("Applies with your next message.") }
                else if !tune.notice.isEmpty { Text(tune.notice) }
                if tune.canReset {
                    Button("Use the model's default effort") { Task { _ = await model.setEffort(nil) } }
                        .buttonStyle(.plain).foregroundStyle(AceTheme.Colours.foreground)
                        .accessibilityIdentifier("composer.tune.default")
                }
            }
        }
    }
}

/// New thread's effort and speed for the first turn: only levels and speeds the model lists.
struct NewThreadTunePanel: View {
    let drafts: NewThreadDraftModel
    let choice: NewThreadChoice

    var body: some View {
        TunePanel(count: (choice.model?.efforts.count ?? 0 > 1 ? 1 : 0) + ((choice.model?.speeds ?? []).count > 1 ? 1 : 0)) {
            if let model = choice.model {
                let speeds = model.speeds ?? []
                if model.efforts.count > 1 {
                    OptionChoiceRow(title: "Effort", items: model.efforts.map { GlassChoiceItem(id: $0.id, label: $0.label) },
                                    selection: choice.effort, idPrefix: "newThread.effort") { effort in pick(model) { $0.effort = effort } }
                }
                if speeds.count > 1 {
                    OptionChoiceRow(title: "Speed", items: speeds.map { GlassChoiceItem(id: $0.speed, label: $0.label) },
                                    selection: drafts.draft.speed ?? model.defaultSpeed ?? "standard",
                                    idPrefix: "newThread.speed") { speed in pick(model) { $0.speed = speed } }
                }
            }
        } footer: { Text("For the thread's first turn.") }
    }
    /// A tuning pick makes the suggested agent and model the draft's own.
    private func pick(_ model: ComposeAgent.Model, _ change: @escaping (inout NewThreadDraft) -> Void) {
        drafts.edit { draft in
            draft.provider = choice.agent?.provider; draft.model = model.key; draft.account = model.account
            change(&draft)
        }
    }
}

/// What the effort part of the model chip says: the level in brief, and the speed when it isn't
/// the standard one ("Med · Fast"); nil when the model has nothing to tune.
enum TuneSummary {
    static func text(effort: String?, speed: String?, hasLevels: Bool, hasSpeeds: Bool) -> String? {
        guard hasLevels || hasSpeeds else { return nil }
        let parts = [effort ?? (hasLevels ? "Default" : nil), speed].compactMap { $0 }
        return parts.isEmpty ? "Standard" : parts.joined(separator: " · ")
    }
}
