import SwiftUI

/// One glass capsule: + · the message · the model · send. When the message wraps it grows into a
/// card with the controls on a row below. While the agent works an empty composer's button stops
/// the whole tree; a typed message goes the way the bridge says (steer or queue), and a long press
/// offers the other delivery where the provider can steer. The model opens the model list.
struct ComposerView<Leading: View, Trailing: View>: View {
    let controls: ControlsRow?
    let stopping: Bool
    let placeholder: String
    let send: (String, Bool) async -> Bool
    let stop: () -> Void
    let inputBegan: () -> Void
    /// A file picked in Files: each new one is inserted as `@path`.
    var mention: ComposerMention? = nil
    /// Files on the next message: with any, the message can go without words.
    var files = 0
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing
    @State private var draft = ComposerDraft()
    @State private var feedback = 0
    @State private var wraps = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var empty: Bool { files == 0 && draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var stops: Bool { empty && controls?.busy == true && controls?.canStop == true }
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(spacing: AceTheme.Spacing.xxs) {
                if !wraps { leading() }
                input
                if !wraps { trailing(); action }
            }
            if wraps {
                HStack(spacing: AceTheme.Spacing.xxs) {
                    leading()
                    Spacer(minLength: AceTheme.Spacing.sm)
                    trailing()
                    action
                }
            }
        }
        .padding(.leading, wraps ? AceTheme.Spacing.xs : AceTheme.Spacing.xxs)
        .padding(.trailing, AceTheme.Spacing.xxs)
        .padding(.vertical, wraps ? AceTheme.Spacing.xs : AceTheme.Spacing.xxs)
        .frame(minHeight: AceTheme.Dimensions.touchTarget + AceTheme.Spacing.sm)
        .aceGlass(in: RoundedRectangle(cornerRadius: wraps ? AceTheme.Radii.composer : (AceTheme.Dimensions.touchTarget + AceTheme.Spacing.sm) / 2, style: .continuous))
        .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: wraps)
        .sensoryFeedback(.impact(weight: .light), trigger: feedback)
        .onChange(of: mention) { _, picked in if let picked { draft.text = Mention.insert(picked.path, into: draft.text) } }
        .padding(.horizontal, AceTheme.Spacing.md).padding(.bottom, AceTheme.Spacing.sm)
    }
    private var input: some View {
        NativeTextInput(text: $draft.text, inputBegan: inputBegan, submit: { if !disabled && !stops { submit(alternate: false) } },
                        wraps: wraps, onWrap: { wraps = $0 })
            .overlay(alignment: .topLeading) {
                if draft.text.isEmpty {
                    Text(placeholder).aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1)
                        .padding(.top, AceTheme.Spacing.md)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .accessibilityLabel(placeholder)
            .padding(.leading, wraps ? AceTheme.Spacing.md : AceTheme.Spacing.none)
            .padding(.trailing, wraps ? AceTheme.Spacing.md : AceTheme.Spacing.xs)
    }
    private var action: some View {
        ComposerActionButton(stopping: stops, saving: draft.saving, disabled: disabled, label: label) {
            feedback += 1
            if stops { stop() } else { submit(alternate: false) }
        }
        .contextMenu {
            if !empty, let alternate = controls?.alternate {
                Button(alternate == "steer" ? "Steer now" : "Queue for after this turn", systemImage: alternate == "steer" ? "arrow.turn.down.right" : "text.line.last.and.arrowtriangle.forward") { submit(alternate: true) }
            }
        }
        .accessibilityIdentifier("composer.send")
    }
    private var disabled: Bool { draft.saving || (stops ? stopping : empty) }
    private var label: String {
        if draft.saving { return "Sending your message" }
        if stops { return stopping ? "Stopping the agent tree" : "Stop whole agent tree" }
        if controls?.busy == true { return controls?.delivery == "steer" ? "Steer the running turn" : "Queue for after this turn" }
        return "Send message"
    }
    private func submit(alternate: Bool) {
        Task { await draft.submit(delivery: alternate ? "alternate" : "follow", files: files) { text, delivery in await send(text, delivery == "alternate") } }
    }
}
