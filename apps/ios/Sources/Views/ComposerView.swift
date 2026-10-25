import SwiftUI

/// The thread's composer as one box: the message on top, and under it, inside the same glass, one
/// compact row of controls: + and the access mode on the left, the model, its effort and the round
/// Send on the right. Nothing sits outside the box. Tapped into, or when the message wraps, the
/// words open to a few lines (in step with the keyboard). While the agent works an empty composer's round
/// button stops the whole tree; a typed message goes the way the bridge says (steer or queue), and
/// a long press offers the other delivery where the provider can steer. Files on the next message
/// sit above the field.
struct ComposerView<Top: View, Leading: View, Access: View, Model: View>: View {
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
    /// Where this composer's unsent words are kept (`ThreadDrafts.key`); nil keeps them only on screen.
    var draftKey: String? = nil
    @ViewBuilder var top: () -> Top
    /// The + at the row's start.
    @ViewBuilder var leading: () -> Leading
    /// The access mode, beside +.
    @ViewBuilder var access: () -> Access
    /// The model and its effort, before Send.
    @ViewBuilder var model: () -> Model
    @State private var draft = ComposerDraft()
    @State private var feedback = 0
    @State private var wraps = false
    @State private var focused = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.threadDrafts) private var drafts
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var empty: Bool { files == 0 && draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var card: Bool { ComposerFit.card(focused: focused, wraps: wraps) }
    private var stops: Bool { empty && controls?.busy == true && controls?.canStop == true }
    var body: some View {
        let bar = ReadingColumn.bar(sizeClass)
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            top()
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                input
                HStack(spacing: AceTheme.Spacing.none) {
                    leading()
                        .frame(width: ComposerControlRow.height, height: ComposerControlRow.height)
                        .contentShape(Rectangle())
                    access()
                    Spacer(minLength: AceTheme.Spacing.xs)
                    model()
                    action
                }
                .padding(.horizontal, AceTheme.Spacing.xs)
                .padding(.bottom, AceTheme.Spacing.xxs)
                // The row keeps its height when a tall request and the keyboard leave little room.
                .fixedSize(horizontal: false, vertical: true)
            }
            .containerShape(AceShape.composerBox)
            .composerGlass(in: AceShape.composerBox)
        }
        .padding(.horizontal, bar.composer).padding(.bottom, bar.bottom)
        .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: wraps)
        .sensoryFeedback(.impact(weight: .light), trigger: feedback)
        .onChange(of: mention) { _, picked in if let picked { draft.text = Mention.insert(picked.path, into: draft.text) } }
        .onChange(of: draftKey, initial: true) { _, key in draft.follow(key, in: drafts) }
        .onChange(of: scenePhase) { _, phase in if phase != .active { draft.flush() } }
        .onDisappear { draft.flush() }
    }
    private var input: some View {
        NativeTextInput(text: $draft.text, inputBegan: inputBegan, submit: { if !disabled && !stops { submit(alternate: false) } },
                        wraps: wraps, onWrap: { wraps = $0 }, card: card, focused: focused,
                        onFocus: { focus, duration in withAnimation(reduceMotion ? nil : .spring(duration: duration, bounce: 0)) { focused = focus } })
            .overlay(alignment: .topLeading) {
                if draft.text.isEmpty {
                    Text(placeholder).aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1)
                        .padding(.top, AceTheme.Spacing.md)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .accessibilityLabel(placeholder)
            .padding(.horizontal, AceTheme.Spacing.lg)
    }
    private var action: some View {
        ComposerActionButton(stopping: stops, saving: draft.saving, disabled: disabled, label: label, size: ComposerControlRow.height + AceTheme.Spacing.xs) {
            feedback += 1
            if stops { stop() } else { submit(alternate: false) }
        }
        .contextMenu {
            if !empty, let alternate = controls?.alternate {
                Button(alternate == "steer" ? "Steer now" : "Queue for after this turn", ace: alternate == "steer" ? .arrowElbowDownRight : .queue) { submit(alternate: true) }
            }
        }
        // ⌘↩ sends from a hardware keyboard; it never stops a running tree.
        .keyboardShortcut(stops ? nil : KeyboardShortcut(.return, modifiers: .command))
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
