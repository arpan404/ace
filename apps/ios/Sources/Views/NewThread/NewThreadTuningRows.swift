import SwiftUI

/// The first turn's speed and the thread's access, as the bridge offers them for the chosen model
/// and agent (`newThreadAccess` in `@ace/ui-core`): only speeds the model lists and modes the
/// agent supports are shown, and a default that had to step down says why.
struct NewThreadTuningRows: View {
    let model: ComposeAgent.Model?
    let access: ComposeAccess?
    /// The draft's own speed; nil runs at the model's default. Access shows what the bridge says it runs at.
    let speed: String?
    let setSpeed: (String) -> Void
    let setAccess: (String) -> Void
    var body: some View {
        if let model, let speeds = model.speeds, speeds.count > 1 {
            Picker("Speed", selection: Binding(get: { speed ?? model.defaultSpeed ?? "standard" }, set: setSpeed)) {
                ForEach(speeds) { tier in Text(tier.label).tag(tier.speed) }
            }
            .accessibilityIdentifier("newThread.speed")
        }
        if let access {
            if access.state == "loading", access.choices.isEmpty {
                LabeledContent("Access") { ProgressView() }
            } else if !access.choices.isEmpty {
                Picker("Access", selection: Binding(get: { access.selected ?? "" }, set: setAccess)) {
                    ForEach(access.choices) { choice in
                        Text(choice.label).tag(choice.mode).accessibilityHint(choice.description)
                    }
                }
                .accessibilityIdentifier("newThread.access")
                if let shown = access.choices.first(where: { $0.mode == access.selected }) {
                    Text(shown.description).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(shown.attention ? AceTheme.StatusText.needsYou : AceTheme.Colours.mutedForeground)
                }
            }
            if let note = access.problem ?? access.stricter {
                Text(note).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(access.problem == nil ? AceTheme.Colours.mutedForeground : AceTheme.StatusText.needsYou)
                    .accessibilityIdentifier("newThread.accessNote")
            }
        }
    }
}
