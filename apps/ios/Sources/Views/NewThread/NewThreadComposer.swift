import SwiftUI

@MainActor enum NewThreadStyle {
    /// The pills' and suggestions' words: row text.
    static let chip = AceTheme.Typography.label
}

/// The first message: the field taking the sheet's height, the `@` and `/` lists over it, the
/// suggestions, then + · mic · Send in one row.
struct NewThreadComposer: View {
    let drafts: NewThreadDraftModel
    let client: ClientModel?
    let files: [AttachmentFile]
    let sending: Bool
    let blocker: String?
    @Binding var attachProblem: String?
    let send: () -> Void
    /// The first message's `@`, `/` and + lists.
    let suggester: ComposerSuggester
    /// A builtin picked from `/` or + that the sheet runs (plan, model, project).
    let run: (String) -> Void
    /// The suggestions row, when it has anything to offer.
    let suggestions: NewThreadSuggestions?
    /// A skill was picked from `/`: the sheet remembers it for this project.
    let pickedSkill: (NewThreadSkill) -> Void
    /// Where the caret goes after a suggestion changed the words.
    @Binding var place: CaretPlacement?
    @State private var focused = false
    @State private var askAttach = false
    @State private var notice: String?
    @State private var dictation = ComposerDictation()
    /// The words before the mic was tapped; the transcript goes after them.
    @State private var beforeDictation = ""
    private var draft: NewThreadDraft { drafts.draft }

    private var text: Binding<String> { Binding(get: { draft.text }, set: { text in drafts.edit { $0.text = text } }) }
    private func pick(_ row: SuggestionRow) {
        if let skill = NewThreadSkill(row) { pickedSkill(skill) }
        suggester.choose(row, text: text, place: $place, keep: { drafts.add($0) }, notice: { notice = $0 }) { action in
            if action == "attach" { askAttach = true } else { run(action) }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            field
                .overlay(alignment: .bottom) {
                    if suggester.trigger != nil {
                        ComposerSuggestionList(list: suggester.shown, pick: pick, retry: { suggester.retry() })
                            .padding(.horizontal, AceDesign.Space.margin - AceDesign.Space.tight)
                    }
                }
            if !files.isEmpty {
                ComposerMediaStrip(files: files, staging: drafts.staging, inset: AceDesign.Space.margin) { id in
                    client?.composeDetach(id)
                    drafts.remove(id)
                }
                .padding(.bottom, AceDesign.Space.related)
            }
            if let note = notice ?? dictation.problem {
                Text(note).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(.horizontal, AceDesign.Space.margin).padding(.bottom, AceDesign.Space.tight)
            }
            if let suggestions { suggestions }
            actions
        }
        .onChange(of: draft.text) { _, _ in notice = nil }
        .modifier(ComposerSuggestHost(suggester: suggester, text: text, place: $place, keep: { drafts.add($0) }))
        .onAppear { suggester.active = true }
        .onDisappear { suggester.active = false; dictation.stop() }
    }

    /// The words, on the sheet itself: no box around them, the page is the field.
    private var field: some View {
        NativeTextInput(text: text, inputBegan: {},
                        submit: { if blocker == nil && !sending { send() } }, card: true, focused: focused,
                        onFocus: { focus, duration in
                            if !focus { suggester.close() } else { suggester.readAhead() }
                            withAnimation(AceDesign.Motion.keyboard(duration)) { focused = focus }
                        },
                        identifier: "newThread.message", focusOnAppear: true,
                        onCaret: { text, caret in suggester.caretMoved(text: text, caret: caret, held: (draft.picks ?? ComposerPicks()).held) },
                        place: place, fills: true, placeholder: draft.isChat ? "Ask anything" : "Describe a task")
            .accessibilityLabel(draft.isChat ? "Message" : "Describe a task")
            .padding(.horizontal, AceDesign.Space.margin)
            .frame(maxHeight: .infinity)
    }

    /// + on the leading edge, the mic and Send on the trailing one.
    private var actions: some View {
        HStack(spacing: AceDesign.Space.related) {
            AttachMenu(stage: { staged in
                guard let client, let project = draft.projectId else { drafts.staging.discard(staged.localId); return }
                drafts.picked(staged, workspaceId: project)
                client.composeAttach(staged, workspaceId: project)
            }, problem: $attachProblem, identifier: "newThread.attach", staging: drafts.staging,
               more: suggester.adding, pickMore: pick, ask: $askAttach)
            .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
            .foregroundStyle(AceTheme.Colours.foreground)
            .tint(AceTheme.Colours.foreground)
            .background { NewThreadRound(fill: AceTheme.Colours.fill) }
            // The new thread takes only the files it was sent with: none joins while it starts.
            .disabled(draft.projectId == nil || client?.canOperate != true || sending)
            Spacer(minLength: AceDesign.Space.related)
            if dictation.available { mic }
            ComposerActionButton(saving: sending, disabled: blocker != nil || sending, label: draft.isChat ? "Start chat" : "Start thread", action: send)
                .fixedSize()
                .accessibilityHint(blocker ?? "").accessibilityIdentifier("newThread.start")
        }
        .padding(.horizontal, AceDesign.Space.margin - AceDesign.Space.tight)
        .padding(.top, AceDesign.Space.tight)
        .padding(.bottom, AceDesign.Space.related)
    }

    private var mic: some View {
        Button {
            if dictation.listening { dictation.stop(); return }
            beforeDictation = draft.text
            Task<Void, Never> {
                await dictation.start { heard in
                    drafts.edit { $0.text = DictationText.join(beforeDictation, heard: heard) }
                }
            }
        } label: {
            Group {
                if dictation.listening {
                    AceShape.stopGlyph.frame(width: AceDesign.Size.stopGlyph, height: AceDesign.Size.stopGlyph)
                } else {
                    AceIcon(.microphone, size: AceDesign.Size.sendGlyph, weight: .bold, relativeTo: .body)
                }
            }
            .foregroundStyle(dictation.listening ? AceTheme.Colours.background : AceTheme.Colours.foreground)
            .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
            .background { NewThreadRound(fill: dictation.listening ? AceTheme.Colours.foreground : AceTheme.Colours.fill) }
            // The whole 44-point square answers, not just the round drawn in it.
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(sending)
        .sensoryFeedback(.selection, trigger: dictation.listening)
        .accessibilityLabel(dictation.listening ? "Stop dictating" : "Dictate")
        .accessibilityIdentifier("newThread.mic")
    }
}

/// Instructions for the first message, from a saved profile or written here.
struct NewThreadInstructionsView: View {
    let drafts: NewThreadDraftModel
    let profiles: [TaskProfile]
    let reloadProfiles: () -> Void
    private var draft: NewThreadDraft { drafts.draft }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    QuietSection("Instructions") {
                        QuietSectionRow {
                            Picker("Profile", selection: Binding(get: { draft.profileId ?? "" }, set: { id in
                                drafts.edit { $0.profileId = id.isEmpty ? nil : id; $0.instructions = profiles.first { $0.id == id }?.instructions }
                            })) {
                                Text("None").tag("")
                                ForEach(profiles) { Text($0.name).tag($0.id) }
                            }
                            .accessibilityIdentifier("newThread.profile")
                        }
                        QuietSectionRow {
                            TextField("Custom instructions", text: Binding(get: { draft.instructions ?? "" }, set: { value in drafts.edit { $0.instructions = value } }), axis: .vertical)
                                .aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                                .lineLimit(2...8)
                                .accessibilityIdentifier("newThread.instructions")
                        }
                    }
                    Text("Included in the thread's first message.")
                        .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .padding(.horizontal, AceDesign.Space.margin)
                }
                QuietSection {
                    NavigationLink { TaskProfilesView(store: TaskProfileStore(defaults: .standard)) } label: {
                        QuietSectionRow {
                            QuietRowText(title: "Manage profiles")
                            RowCaret()
                        }
                    }
                    .accessibilityIdentifier("newThread.profiles")
                }
            }
            .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
        }
        .background(AceDesign.Surface.background)
        .onAppear(perform: reloadProfiles)
        .navigationTitle("Instructions").navigationBarTitleDisplayMode(.inline)
    }
}

/// The round behind + and the mic: Send's size, inside the same full tap.
struct NewThreadRound: View {
    let fill: Color
    var body: some View { Circle().fill(fill).frame(width: AceDesign.Size.send, height: AceDesign.Size.send) }
}
