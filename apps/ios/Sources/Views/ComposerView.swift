import SwiftUI

/// The floating composer. While the agent works an empty composer's button stops the whole tree;
/// a typed message goes the way the bridge says (steer or queue), and a long press offers the
/// other delivery where the provider can steer. The model chip opens the model list.
struct ComposerView: View {
    @Environment(\.colorScheme) private var colourScheme
    let controls: ControlsRow?
    let stopping: Bool
    let placeholder: String
    let send: (String, Bool) async -> Bool
    let stop: () -> Void
    let openModels: () -> Void
    let inputBegan: () -> Void
    @State private var draft = ComposerDraft()
    @State private var feedback = 0
    private var empty: Bool { draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var stops: Bool { empty && controls?.busy == true && controls?.canStop == true }
    var body: some View {
        HStack(alignment: .bottom, spacing: AceTheme.Spacing.md) {
            NativeTextInput(text: $draft.text, inputBegan: inputBegan)
                .overlay(alignment: .leading) {
                    if draft.text.isEmpty { Text(placeholder).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.subtleForeground).allowsHitTesting(false) }
                }
            if let model = controls?.model, !model.isEmpty {
                Button(action: openModels) {
                    HStack(spacing: AceTheme.Spacing.xxs) {
                        Text(model).lineLimit(1)
                        if controls?.switching == "queued" { Image(systemName: "clock") }
                    }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs).background(AceTheme.Colours.fill, in: Capsule())
                    .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Model: \(model)\(controls?.switching == "queued" ? ", switching from the next turn" : "")")
                .accessibilityIdentifier("composer.model")
            }
            Button {
                feedback += 1
                if stops { stop() } else { submit(alternate: false) }
            } label: {
                Image(systemName: stops ? "stop.fill" : "arrow.up")
                    .aceFont(AceTheme.Typography.title, relativeTo: .body).frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
                    .foregroundStyle(AceTheme.Colours.background).background(AceTheme.Colours.foreground, in: Circle())
                    .opacity(disabled ? AceTheme.Opacity.disabled(colourScheme) : 1)
            }
            .disabled(disabled)
            .contextMenu {
                if !empty, let alternate = controls?.alternate {
                    Button(alternate == "steer" ? "Steer now" : "Queue for after this turn", systemImage: alternate == "steer" ? "arrow.turn.down.right" : "text.line.last.and.arrowtriangle.forward") { submit(alternate: true) }
                }
            }
            .accessibilityLabel(label)
            .accessibilityIdentifier("composer.send")
        }
        .padding(.leading, AceTheme.Spacing.lg).padding(.trailing, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.sm)
        .floatingGlass()
        .sensoryFeedback(.impact(weight: .light), trigger: feedback)
        .padding(.horizontal, AceTheme.Dimensions.composerInset).padding(.bottom, AceTheme.Spacing.sm)
    }
    private var disabled: Bool { draft.saving || (stops ? stopping : empty) }
    private var label: String {
        if draft.saving { return "Saving your message" }
        if stops { return stopping ? "Stopping the agent tree" : "Stop whole agent tree" }
        if controls?.busy == true { return controls?.delivery == "steer" ? "Steer the running turn" : "Queue for after this turn" }
        return "Send message"
    }
    private func submit(alternate: Bool) {
        Task { await draft.submit(delivery: alternate ? "alternate" : "follow") { text, delivery in await send(text, delivery == "alternate") } }
    }
}
