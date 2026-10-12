import SwiftUI

struct ComposerView: View {
    let state: String
    let modelName: String
    let canSteer: Bool
    let send: (String, String) async -> Bool
    let stop: () -> Void
    let inputBegan: () -> Void
    @State private var draft = ComposerDraft()
    @State private var delivery = "queue"
    @State private var feedback = 0
    var body: some View {
        HStack(alignment: .bottom, spacing: AceTheme.Spacing.md) {
            NativeTextInput(text: $draft.text, inputBegan: inputBegan)
                .overlay(alignment: .leading) {
                    if draft.text.isEmpty { Text("Steer or follow up…").aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.subtleForeground).allowsHitTesting(false) }
                }
            Menu {
                Button("Queue follow-up", systemImage: "text.line.last.and.arrowtriangle.forward") { delivery = "queue" }
                if canSteer { Button("Steer now", systemImage: "arrow.turn.up.right") { delivery = "steer" } }
            } label: {
                Text(modelName.isEmpty ? "\(delivery.capitalized)" : modelName)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                    .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs).background(AceTheme.Colours.fill, in: Capsule())
            }.accessibilityLabel("Delivery: \(delivery). Model: \(modelName)")
            Button {
                feedback += 1
                if draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { stop() }
                else { Task { await draft.submit(delivery: delivery, persist: send) } }
            } label: {
                Image(systemName: draft.text.isEmpty && state == "working" ? "stop.fill" : "arrow.up")
                    .aceFont(AceTheme.Typography.title, relativeTo: .body).frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
                    .foregroundStyle(AceTheme.Colours.background).background(AceTheme.Colours.foreground, in: Circle())
            }
            .disabled(draft.saving || (draft.text.isEmpty && state != "working"))
            .accessibilityLabel(draft.saving ? "Saving your message" : draft.text.isEmpty && state == "working" ? "Stop whole agent tree" : "Send message")
            .accessibilityIdentifier("composer.send")
        }
        .padding(.leading, AceTheme.Spacing.lg).padding(.trailing, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.sm)
        .floatingGlass()
        .sensoryFeedback(.impact(weight: .light), trigger: feedback)
        .padding(.horizontal, AceTheme.Dimensions.composerInset).padding(.bottom, AceTheme.Spacing.sm)
    }
}
