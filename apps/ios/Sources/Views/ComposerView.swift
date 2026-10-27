import SwiftUI

/// The thread's composer. At rest it is one slim capsule: +, the message, a settings button and the
/// round Send. Once it is big (tapped into, or the message wraps or holds words) it opens like the
/// web's: the message on top and, inside the same glass, one row of + and the access mode on the
/// left, the model, its effort and Send on the right; the settings button goes, its controls now
/// showing. The message keeps its place in both, so focus and the draft never drop. While the agent works an empty composer's round
/// button stops the whole tree; a typed message goes the way the bridge says (steer or queue), and
/// a long press offers the other delivery where the provider can steer. Files on the next message
/// sit above the field.
struct ComposerView<Top: View, Leading: View, Access: View, Model: View, Settings: View>: View {
    let controls: ControlsRow?
    let stopping: Bool
    let placeholder: String
    /// The words, whether to use the other delivery, and the references picked into them.
    let send: (String, Bool, [Any]) async -> Bool
    let stop: () -> Void
    let inputBegan: () -> Void
    /// A file picked in Files: each new one is inserted as `@path`.
    var mention: ComposerMention? = nil
    /// Files on the next message: with any, the message can go without words.
    var files = 0
    /// Where this composer's unsent words are kept (`ThreadDrafts.key`); nil keeps them only on screen.
    var draftKey: String? = nil
    /// The `@` and `/` lists, and the + list's builtins; nil offers none.
    var suggester: ComposerSuggester? = nil
    /// The most the `@` and `/` list may take, so the message stays above the keyboard.
    var suggestionHeight: CGFloat? = nil
    /// A builtin picked from `/` or + that the screen runs (attach, plan, model, review).
    var run: (String) -> Void = { _ in }
    @ViewBuilder var top: () -> Top
    /// The + at the row's start; it is handed what picking one of the + list's rows does.
    @ViewBuilder var leading: (_ pick: @escaping (SuggestionRow) -> Void) -> Leading
    /// The access mode, beside +.
    @ViewBuilder var access: () -> Access
    /// The model and its effort, before Send.
    @ViewBuilder var model: () -> Model
    /// The button that opens the model, effort and access while the composer is one line.
    @ViewBuilder var settings: () -> Settings
    @State private var draft = ComposerDraft()
    @State private var feedback = 0
    @State private var wraps = false
    @State private var focused = false
    @State private var place: CaretPlacement?
    /// Why the last pick couldn't be made, until the words change.
    @State private var notice: String?
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Environment(\.threadDrafts) private var drafts
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var empty: Bool { files == 0 && draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var card: Bool { ComposerFit.card(focused: focused, wraps: wraps) }
    /// Big: the web's layout, with the controls row under the message.
    private var big: Bool { card || !empty }
    private var stops: Bool { empty && controls?.busy == true && controls?.canStop == true }
    var body: some View {
        let bar = ReadingColumn.bar(sizeClass)
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if let suggester, suggester.trigger != nil {
                ComposerSuggestionList(list: suggester.shown, pick: pick, retry: { suggester.retry() }, maxHeight: suggestionHeight)
                    .transition(.opacity)
            }
            if let notice {
                Text(notice).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(.horizontal, AceTheme.Spacing.lg).padding(.bottom, AceTheme.Spacing.xs)
            }
            top()
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                HStack(alignment: .center, spacing: AceTheme.Spacing.none) {
                    if !big { plus }
                    input
                    if !big {
                        settings()
                            .frame(width: ComposerControlRow.height, height: ComposerControlRow.height)
                            .background(AceTheme.Colours.fill, in: Circle())
                            .padding(.trailing, AceTheme.Spacing.xxs)
                        action
                    }
                }
                .padding(.horizontal, big ? AceTheme.Spacing.none : AceTheme.Spacing.xs)
                .frame(minHeight: AceTheme.Dimensions.touchTarget + AceTheme.Spacing.xs)
                if big {
                    HStack(spacing: AceTheme.Spacing.none) {
                        plus
                        access()
                        Spacer(minLength: AceTheme.Spacing.xs)
                        model()
                        action
                    }
                    .padding(.horizontal, AceTheme.Spacing.xs)
                    .padding(.bottom, AceTheme.Spacing.xxs)
                    // The row keeps its height when a tall request and the keyboard leave little room.
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
                }
            }
            .aceContainerShape(AceShape.field)
            .composerGlass(in: AceShape.field)
            .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: big)
        }
        .padding(.horizontal, bar.composer).padding(.bottom, bar.bottom)
        .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: wraps)
        .sensoryFeedback(.impact(weight: .light), trigger: feedback)
        .onChange(of: mention) { _, picked in
            guard let picked else { return }
            draft.text = Mention.insert(picked.path, into: draft.text)
            draft.add(.file(picked.path, endingAt: draft.text))
        }
        .onChange(of: draft.text) { _, _ in notice = nil }
        .modifier(ComposerSuggestHost(suggester: suggester, text: $draft.text, place: $place, keep: { draft.add($0) }))
        .onAppear { suggester?.active = true }
        .onDisappear { suggester?.active = false }
        .onChange(of: draftKey, initial: true) { _, key in draft.follow(key, in: drafts) }
        .onChange(of: scenePhase) { _, phase in if phase != .active { draft.flush() } }
        .onDisappear { draft.flush() }
    }
    private func pick(_ row: SuggestionRow) {
        suggester?.choose(row, text: $draft.text, place: $place, keep: { draft.add($0) }, notice: { notice = $0 }, run: run)
    }
    private var plus: some View {
        leading(pick)
            .frame(width: ComposerControlRow.height, height: ComposerControlRow.height)
            .contentShape(Rectangle())
    }
    private var input: some View {
        NativeTextInput(text: $draft.text, inputBegan: inputBegan, submit: { if !disabled && !stops { submit(alternate: false) } },
                        wraps: wraps, onWrap: { wraps = $0 }, card: card, focused: focused,
                        onFocus: { focus, duration in
                            if !focus { suggester?.close() } else { suggester?.readAhead() }
                            withAnimation(reduceMotion ? nil : .spring(duration: duration, bounce: 0)) { focused = focus }
                        },
                        onCaret: suggester.map { suggester in { text, caret in suggester.caretMoved(text: text, caret: caret, held: draft.picks.held) } },
                        place: place)
            .overlay(alignment: .topLeading) {
                if draft.text.isEmpty {
                    Text(placeholder).aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1)
                        .padding(.top, AceTheme.Spacing.md)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .accessibilityLabel(placeholder)
            .padding(.horizontal, big ? AceTheme.Spacing.lg : AceTheme.Spacing.xs)
    }
    private var action: some View {
        ComposerActionButton(stopping: stops, saving: draft.saving, disabled: disabled, label: label, glyph: glyph, size: ComposerControlRow.height + AceTheme.Spacing.xs) {
            feedback += 1
            if stops { stop() } else { submit(alternate: false) }
        }
        .contextMenu {
            if !empty, let alternate = controls?.alternate {
                Button(alternate == "steer" ? "Steer now" : "Queue for after this turn", ace: alternate == "steer" ? .arrowBendUpRight : .queue) { submit(alternate: true) }
            }
        }
        // ⌘↩ sends from a hardware keyboard; it never stops a running tree.
        .phoneShortcut("send", enabled: !stops)
        .accessibilityIdentifier("composer.send")
    }
    private var disabled: Bool { draft.saving || (stops ? stopping : empty) }
    private var label: String {
        if draft.saving { return "Sending your message" }
        if stops { return stopping ? "Stopping the agent tree" : "Stop whole agent tree" }
        if controls?.busy == true { return controls?.delivery == "steer" ? "Steer the running turn" : "Queue for after this turn" }
        return "Send message"
    }
    /// What a typed message does now, in the web's glyphs: Steer or Queue while the agent works.
    private var glyph: AceIcon.Name {
        guard controls?.busy == true else { return .arrowUp }
        return controls?.delivery == "steer" ? .arrowBendUpRight : .queue
    }
    private func submit(alternate: Bool) {
        let suggester = suggester
        let draft = draft
        Task {
            await draft.submit(delivery: alternate ? "alternate" : "follow", files: files) { text, delivery in
                let saved = await send(text, delivery == "alternate", draft.picks.payload)
                if saved { suggester?.sent() }
                return saved
            }
        }
    }
}
