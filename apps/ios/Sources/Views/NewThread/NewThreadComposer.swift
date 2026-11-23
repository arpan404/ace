import SwiftUI

@MainActor enum NewThreadStyle {
    /// The pills' and suggestions' words: row text.
    static let chip = AceTheme.Typography.label
}

/// The first message, docked with its choices, suggestions and attachments.
struct NewThreadComposer<Choices: View>: View {
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
    @ViewBuilder var choices: () -> Choices
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
            GeometryReader { room in
                if suggester.trigger != nil {
                    ComposerSuggestionList(list: suggester.shown, pick: pick, retry: { suggester.retry() },
                                           maxHeight: room.size.height)
                        .frame(maxHeight: .infinity, alignment: .bottom)
                }
            }
            if !files.isEmpty {
                ComposerMediaStrip(files: files, staging: drafts.staging, inset: AceDesign.Space.margin, remove: { id in
                    client?.composeDetach(id)
                    drafts.remove(id)
                }, retry: { client?.composeRetry($0) })
                .padding(.bottom, AceDesign.Space.related)
            }
            if let note = notice ?? dictation.problem {
                Text(note).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(.horizontal, AceDesign.Space.margin).padding(.bottom, AceDesign.Space.tight)
            }
            if let suggestions { suggestions }
            choices()
            ComposerCapsule {
                attach.accessibilitySortPriority(2)
            } field: {
                field.accessibilitySortPriority(3)
            } trailing: {
                if dictation.available { mic.accessibilitySortPriority(1) }
                ComposerTrailingButton(state: .send, saving: sending, disabled: blocker != nil || sending,
                                       label: draft.isChat ? "Start chat" : "Start thread", action: send)
                    .accessibilityHint(blocker ?? "")
                    .accessibilityIdentifier("newThread.start")
            }
        }
        .onChange(of: draft.text) { _, _ in notice = nil }
        .modifier(ComposerSuggestHost(suggester: suggester, text: text, place: $place, keep: { drafts.add($0) }))
        .onAppear { suggester.active = true }
        .onDisappear { suggester.active = false; dictation.stop() }
    }

    private var field: some View {
        NativeTextInput(text: text, inputBegan: {},
                        submit: { if blocker == nil && !sending { send() } },
                        focused: focused, holdsOneLine: true,
                        onFocus: { focus, _ in
                            if !focus { suggester.close() } else { suggester.readAhead() }
                            focused = focus
                        },
                        identifier: "newThread.message", focusOnAppear: true,
                        onCaret: { text, caret in suggester.caretMoved(text: text, caret: caret, held: (draft.picks ?? ComposerPicks()).held) },
                        place: place, placeholder: dictation.listening ? "Listening…" : (draft.isChat ? "Ask anything" : "Describe a task"),
                        accessibleName: draft.isChat ? "Message" : "Describe a task")
    }

    private var attach: some View {
        AttachMenu(stage: { staged in
            guard let client, let project = draft.projectId else { drafts.staging.discard(staged.localId); return }
            drafts.picked(staged, workspaceId: project)
            client.composeAttach(staged, workspaceId: project)
        }, problem: $attachProblem, identifier: "newThread.attach", staging: drafts.staging,
           more: suggester.adding, pickMore: pick, ask: $askAttach)
            .disabled(draft.projectId == nil || client?.canOperate != true || sending)
    }

    private var mic: some View {
        ComposerTrailingButton(state: dictation.listening ? .listening : .dictate, disabled: sending,
                               label: dictation.listening ? "Stop dictating" : "Dictate") {
            if dictation.listening { dictation.stop(); return }
            beforeDictation = draft.text
            Task<Void, Never> {
                await dictation.start { heard in
                    drafts.edit { $0.text = DictationText.join(beforeDictation, heard: heard) }
                }
            }
        }
        .sensoryFeedback(.selection, trigger: dictation.listening)
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
                                .aceFont(AceDesign.TextRole.rowTitle)
                                .lineLimit(2...8)
                                .accessibilityIdentifier("newThread.instructions")
                        }
                    }
                    Text("Included in the thread's first message.")
                        .aceFont(AceDesign.TextRole.meta)
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
