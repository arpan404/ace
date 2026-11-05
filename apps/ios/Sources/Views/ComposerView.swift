import SwiftUI

/// The thread's composer, one Liquid Glass capsule as Messages draws it: a round glass + on its
/// left, then the capsule holding the field and one trailing round button (`ComposerTrailing`):
/// the microphone while there is nothing to send or stop, Send once there are words or chips, Stop
/// while the tree works and the field is empty. A typed message steers or queues as the bridge
/// directs. The words wrap and the capsule grows into a rounded shape concentric with its button,
/// up to five lines, then scrolls. What rides above it (the files and chips on the next message)
/// is `top`; the model lives in the thread's title, never here.
struct ComposerView<Top: View, Leading: View>: View {
    let controls: ControlsRow?
    let stopping: Bool
    let placeholder: String
    /// The words, whether to use the other delivery, and the references picked into them.
    let send: (String, Bool, [Any]) async -> Bool
    let stop: () -> Void
    let inputBegan: () -> Void
    /// A file picked in Files: each new one is inserted as `@path`.
    var mention: ComposerMention? = nil
    /// Images, files and folders pasted or dropped onto the composer; nil takes only words.
    var intake: (([NSItemProvider]) -> Void)? = nil
    /// An earlier message the person sent, `older` 0 the latest; nil where there is none to recall.
    var recall: ((Int) async -> String?)? = nil
    /// Files on the next message: with any, the message can go without words.
    var files = 0
    /// Chips on the next message (line comments, drawings): with any, the message can go without
    /// words. They sit above the capsule; its shape never changes for them.
    var chips = 0
    /// Where this composer's unsent words are kept (`ThreadDrafts.key`); nil keeps them only on screen.
    var draftKey: String? = nil
    /// The `@` and `/` lists, and the + list's builtins; nil offers none.
    var suggester: ComposerSuggester? = nil
    /// The most the `@` and `/` list may take, so the message stays above the keyboard.
    var suggestionHeight: CGFloat? = nil
    /// A builtin picked from `/` or + that the screen runs (attach, plan, model, review).
    var run: (String) -> Void = { _ in }
    /// Each new value brings the keyboard up with the caret at the end of the words.
    var focusRequest = 0
    /// What sits just above the capsule: the files and chips on the next message, the fork.
    @ViewBuilder var top: () -> Top
    /// The + at the row's start; it is handed what picking one of the + list's rows does.
    @ViewBuilder var leading: (_ pick: @escaping (SuggestionRow) -> Void) -> Leading
    /// Previous message's walk back through what was sent.
    @State private var recaller = ComposerRecaller()
    /// Something is being dragged over the composer.
    @State private var dropping = false
    @State private var draft = ComposerDraft()
    @State private var dictation = ComposerDictation()
    /// What the field held as dictation began; spoken words follow it.
    @State private var spokenAfter = ""
    @State private var feedback = 0
    @State private var stopped = 0
    @State private var wraps = false
    @State private var focused = false
    @State private var place: CaretPlacement?
    /// Why the last pick couldn't be made, until the words change.
    @State private var notice: String?
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Environment(\.threadDrafts) private var drafts
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var words: Bool { !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var empty: Bool { files == 0 && chips == 0 && !words }
    private var trailing: ComposerTrailing {
        ComposerTrailing.of(hasContent: !empty, busy: controls?.busy == true, canStop: controls?.canStop == true,
                            listening: dictation.listening)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if let suggester, suggester.trigger != nil {
                ComposerSuggestionList(list: suggester.shown, pick: pick, retry: { suggester.retry() }, maxHeight: suggestionHeight)
                    .transition(.opacity)
            }
            if let words = notice ?? dictation.problem {
                Text(words).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(.leading, ComposerCapsuleMetrics.aboveInset).padding(.trailing, AceDesign.Space.margin)
                    .padding(.bottom, AceDesign.Space.tight)
            }
            top()
            HStack(alignment: .bottom, spacing: AceDesign.Space.related) {
                leading(pick)
                    .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .tint(AceTheme.Colours.foreground)
                    .buttonStyle(.plain)
                    .aceGlass(in: Circle(), interactive: true)
                capsule
            }
            .composerGlassGroup()
        }
        .padding(.horizontal, ComposerCapsuleMetrics.side(sizeClass)).padding(.bottom, ReadingColumn.bar(sizeClass).bottom)
        .animation(AceDesign.Motion.arriving(reduceMotion), value: wraps)
        .animation(AceDesign.Motion.arriving(reduceMotion), value: trailing)
        .sensoryFeedback(AceDesign.Haptic.send, trigger: feedback)
        .sensoryFeedback(AceDesign.Haptic.stop, trigger: stopped)
        .onChange(of: mention) { _, picked in
            guard let picked else { return }
            if let tab = picked.tab {
                let inserted = Mention.insert(tab: tab, into: draft.text)
                draft.text = inserted.text
                draft.add(inserted.pick)
                return
            }
            draft.text = Mention.insert(picked.written, into: draft.text)
            draft.add(.file(picked.path, lines: picked.lines, endingAt: draft.text))
        }
        .onChange(of: draft.text) { _, _ in notice = nil }
        .modifier(ComposerSuggestHost(suggester: suggester, text: $draft.text, place: $place, keep: { draft.add($0) }))
        .onAppear { suggester?.active = true }
        .onDisappear { suggester?.active = false }
        .onChange(of: draftKey, initial: true) { _, key in draft.follow(key, in: drafts) }
        .onChange(of: focusRequest) { _, _ in place = CaretPlacement(offset: (draft.text as NSString).length, focus: true) }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { draft.flush(); dictation.stop() }
        }
        .onDisappear { draft.flush(); dictation.stop() }
    }

    /// The field and its one button in a glass capsule; wrapped words make it a rounded shape
    /// whose corners stay concentric with the button's.
    private var capsule: some View {
        HStack(alignment: .bottom, spacing: AceTheme.Spacing.none) {
            input
            action
        }
        .frame(minHeight: AceDesign.Size.tap)
        .aceContainerShape(AceShape.field)
        .composerGlass(in: AceShape.field)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer.surface")
        // A file dragged over the composer: its edge brightens where it will land.
        .overlay {
            if dropping {
                AceShape.field.strokeBorder(AceDesign.Ink.faint, lineWidth: AceTheme.Dimensions.border * 2)
                    .allowsHitTesting(false).transition(.opacity)
            }
        }
        .onDrop(of: intake == nil ? [] : [.item], isTargeted: $dropping) { providers in
            guard let intake else { return false }
            intake(providers)
            feedback += 1
            return true
        }
        .animation(AceDesign.Motion.arriving(reduceMotion), value: dropping)
    }

    private func pick(_ row: SuggestionRow) {
        if row.action == "recall" { recallPrevious(); return }
        suggester?.choose(row, text: $draft.text, place: $place, keep: { draft.add($0) }, notice: { notice = $0 }, run: run)
    }
    /// Previous message: into an empty composer, or one further back while the composer still
    /// holds the last one recalled; otherwise after what is typed, so nothing typed is lost.
    private func recallPrevious() {
        guard let recall else { return }
        let draft = draft
        Task {
            switch await recaller.recall(into: draft, fetch: recall) {
            case .recalled: feedback += 1
            case .none(let words): notice = words
            case .skipped: break
            }
        }
    }
    private var shownPlaceholder: String { dictation.listening ? "Listening…" : placeholder }
    private var input: some View {
        NativeTextInput(text: $draft.text, inputBegan: inputBegan, submit: { if !disabled && trailing == .send { submit(alternate: false) } },
                        wraps: wraps, onWrap: { wraps = $0 }, card: wraps, focused: focused, holdsOneLine: true,
                        onFocus: { focus, duration in
                            if !focus { suggester?.close() } else { suggester?.readAhead() }
                            withAnimation(reduceMotion ? nil : AceDesign.Motion.keyboard(duration)) { focused = focus }
                        },
                        onCaret: suggester.map { suggester in { text, caret in suggester.caretMoved(text: text, caret: caret, held: draft.picks.held) } },
                        place: place, pasteFiles: intake)
            .overlay(alignment: .topLeading) {
                if draft.text.isEmpty {
                    Text(shownPlaceholder).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1)
                        .padding(.top, AceDesign.Space.row)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .accessibilityLabel(placeholder)
            .padding(.leading, ComposerCapsuleMetrics.fieldInset)
    }
    private var action: some View {
        ComposerTrailingButton(state: trailing, saving: draft.saving, disabled: disabled, label: label, sendGlyph: sendGlyph) {
            switch trailing {
            case .dictate: startDictation()
            case .listening: dictation.stop()
            case .stop: stopped += 1; stop()
            case .send: feedback += 1; submit(alternate: false)
            }
        }
        .contextMenu {
            if !empty, let alternate = controls?.alternate {
                Button(alternate == "steer" ? "Steer now" : "Queue for after this turn", ace: alternate == "steer" ? .arrowBendUpRight : .queue) { submit(alternate: true) }
            }
        }
        // ⌘↩ sends from a hardware keyboard; it never stops a running tree.
        .phoneShortcut("send", enabled: trailing == .send)
        .accessibilityIdentifier(trailing == .send || trailing == .stop ? "composer.send" : "composer.dictate")
    }
    private func startDictation() {
        spokenAfter = draft.text
        Task {
            await dictation.start { spoken in draft.text = DictationText.join(spokenAfter, heard: spoken) }
        }
    }
    private var disabled: Bool {
        if draft.saving { return true }
        switch trailing {
        case .stop: return stopping
        case .send: return empty
        case .dictate, .listening: return false
        }
    }
    private var label: String {
        if draft.saving { return "Sending your message" }
        switch trailing {
        case .dictate: return "Dictate"
        case .listening: return "Stop dictating"
        case .stop: return stopping ? "Stopping the agent tree" : "Stop whole agent tree"
        case .send:
            if controls?.busy == true { return controls?.delivery == "steer" ? "Steer the running turn" : "Queue for after this turn" }
            return "Send message"
        }
    }
    /// What a typed message does now, in the web's glyphs: Steer or Queue while the agent works.
    private var sendGlyph: AceIcon.Name {
        guard controls?.busy == true else { return .arrowUp }
        return controls?.delivery == "steer" ? .arrowBendUpRight : .queue
    }
    private func submit(alternate: Bool) {
        dictation.stop()
        let suggester = suggester
        let draft = draft
        Task {
            await draft.submit(delivery: alternate ? "alternate" : "follow", files: files + chips) { text, delivery in
                let saved = await send(text, delivery == "alternate", draft.picks.payload)
                if saved { suggester?.sent() }
                return saved
            }
        }
    }
}

/// Where the capsule sits and where its words start, so what rides above it (the live line, the
/// chips, a notice) shares the field text's left edge.
enum ComposerCapsuleMetrics {
    /// From the column's edge to the + and the capsule.
    static func side(_ sizeClass: UserInterfaceSizeClass?) -> CGFloat { ReadingColumn.bar(sizeClass).composer }
    /// From the capsule's left edge to its words.
    static let fieldInset = AceDesign.Space.row
    /// From the + row's leading edge to the field's words: past the +, the gap and the field's inset.
    static let aboveInset = AceDesign.Size.tap + AceDesign.Space.related + fieldInset
    /// From the column's edge to the field's words.
    static func textEdge(_ sizeClass: UserInterfaceSizeClass?) -> CGFloat { side(sizeClass) + aboveInset }
}

/// Words handed back to the composer. They follow what is already typed after a blank line, as
/// the web's returned draft does, so nothing typed is lost.
struct ComposerRestore: Equatable {
    let id = UUID()
    let text: String
    func merged(into current: String) -> String {
        let typed = current.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        return typed.isEmpty ? text : "\(typed)\n\n\(text)"
    }
}
