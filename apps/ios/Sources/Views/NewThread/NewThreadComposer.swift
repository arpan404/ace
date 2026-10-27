import SwiftUI

@MainActor enum NewThreadStyle {
    static let hero = AceTheme.TypeStyle(size: 28, lineHeight: 34, weight: 500, tracking: -0.56)
    static let chip = AceTheme.TypeStyle(size: 14.5, lineHeight: 19, weight: 500, tracking: 0)
    /// The quiet ⌄ after the hero question that says it opens a picker.
    static var disclosure: Text {
        Text(" \(Image(systemName: "chevron.down"))").font(.title3.weight(.semibold)).foregroundStyle(AceTheme.Colours.mutedForeground)
    }
}

/// "⑂ New worktree ⌄" and "From main ⌄": where the thread works, as chips over the composer.
struct NewThreadWorktreeChips: View {
    let drafts: NewThreadDraftModel
    let branches: (state: String, bases: [ComposeBase], start: ComposeBaseRef?, noWorktree: String?)?
    private var draft: NewThreadDraft { drafts.draft }
    private var worktree: Bool { draft.worktree && branches?.noWorktree == nil }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Menu {
                    Picker("Where it works", selection: Binding(get: { worktree }, set: { on in drafts.edit { $0.worktree = on } })) {
                        Label("Local checkout", systemImage: "folder").tag(false)
                        Label("New worktree", systemImage: "arrow.triangle.branch").tag(true)
                    }
                } label: {
                    chip(worktree ? "New worktree" : "Local checkout", systemImage: worktree ? "arrow.triangle.branch" : "folder")
                }
                .disabled(branches?.noWorktree != nil || branches?.state != "ready")
                .accessibilityHint(branches?.noWorktree ?? "")
                .accessibilityIdentifier("newThread.worktree")
                if worktree, let branches, !branches.bases.isEmpty {
                    let selected = draft.base ?? branches.start
                    Menu {
                        Picker("Starts from", selection: Binding<ComposeBaseRef?>(get: { selected }, set: { base in drafts.edit { $0.base = base } })) {
                            ForEach(branches.bases) { base in
                                let tag: ComposeBaseRef? = base.base
                                Text(base.title).tag(tag)
                            }
                        }
                    } label: {
                        chip("From \(branches.bases.first { $0.base == selected }?.label ?? "default")", systemImage: nil)
                    }
                    .accessibilityIdentifier("newThread.base")
                }
            }
            .padding(.horizontal, AceTheme.Spacing.xxs)
        }
        .scrollClipDisabled()
    }
    private func chip(_ title: String, systemImage: String?) -> some View {
        HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(title).lineLimit(1)
            Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(AceTheme.Colours.mutedForeground)
        }
        .aceFont(NewThreadStyle.chip, relativeTo: .subheadline)
        .foregroundStyle(AceTheme.Colours.foreground)
        .padding(.horizontal, AceTheme.Spacing.md + AceTheme.Spacing.xxs)
        .frame(minHeight: 38)
        .background(AceTheme.Colours.fill, in: AceShape.capsule)
        .contentShape(AceShape.capsule)
    }
}

/// The first message: its files, the words, then + · access · the model and its effort · send.
struct NewThreadComposer: View {
    let drafts: NewThreadDraftModel
    let client: ClientModel?
    let files: [AttachmentFile]
    let choice: NewThreadChoice
    let agentsState: String?
    let sending: Bool
    let blocker: String?
    @Binding var attachProblem: String?
    let chooseModel: () -> Void
    /// Opens effort and speed for the first turn.
    let chooseTune: () -> Void
    let send: () -> Void
    /// The first message's `@`, `/` and + lists.
    let suggester: ComposerSuggester
    /// A builtin picked from `/` or + that the sheet runs (plan, model, project).
    let run: (String) -> Void
    @State private var focused = false
    @State private var place: CaretPlacement?
    @State private var askAttach = false
    @State private var notice: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var draft: NewThreadDraft { drafts.draft }

    private var text: Binding<String> { Binding(get: { draft.text }, set: { text in drafts.edit { $0.text = text } }) }
    private func pick(_ row: SuggestionRow) {
        suggester.choose(row, text: text, place: $place, keep: { drafts.add($0) }, notice: { notice = $0 }) { action in
            if action == "attach" { askAttach = true } else { run(action) }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if suggester.trigger != nil {
                ComposerSuggestionList(list: suggester.shown, pick: pick, retry: { suggester.retry() })
            }
            if let notice {
                Text(notice).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(.horizontal, AceTheme.Spacing.sm).padding(.bottom, AceTheme.Spacing.xs)
            }
            surface
        }
        .onChange(of: draft.text) { _, _ in notice = nil }
        .modifier(ComposerSuggestHost(suggester: suggester, text: text, place: $place, keep: { drafts.add($0) }))
        .onAppear { suggester.active = true }
        .onDisappear { suggester.active = false }
    }
    private var surface: some View {
        ComposerSurface {
            if !files.isEmpty {
                ComposerMediaStrip(files: files, staging: drafts.staging, inset: AceTheme.Spacing.md) { id in
                    client?.composeDetach(id)
                    drafts.remove(id)
                }
            }
            // The thread composer's text view: a few lines tall while focused, and it grows to five
            // lines, then scrolls.
            NativeTextInput(text: text, inputBegan: {},
                            submit: { if blocker == nil && !sending { send() } }, card: true, focused: focused,
                            onFocus: { focus, duration in
                                if !focus { suggester.close() } else { suggester.readAhead() }
                                withAnimation(reduceMotion ? nil : .spring(duration: duration, bounce: 0)) { focused = focus }
                            },
                            identifier: "newThread.message", focusOnAppear: true,
                            onCaret: { text, caret in suggester.caretMoved(text: text, caret: caret, held: (draft.picks ?? ComposerPicks()).held) }, place: place)
                .overlay(alignment: .topLeading) {
                    if draft.text.isEmpty {
                        Text("Describe a task").aceFont(AceTheme.Typography.body, relativeTo: .body)
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                            .padding(.top, AceTheme.Spacing.md)
                            .allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
                .accessibilityLabel("Describe a task")
                .padding(.horizontal, AceTheme.Spacing.lg)
            HStack(spacing: AceTheme.Spacing.xs) {
                AttachMenu(stage: { staged in
                    guard let client, let project = draft.projectId else { drafts.staging.discard(staged.localId); return }
                    drafts.picked(staged, workspaceId: project)
                    client.composeAttach(staged, workspaceId: project)
                }, problem: $attachProblem, identifier: "newThread.attach", staging: drafts.staging,
                   more: suggester.adding, pickMore: pick, ask: $askAttach) {
                    Image(systemName: "plus").font(.title3).foregroundStyle(AceTheme.Colours.foreground)
                }
                // The new thread takes only the files it was sent with: none joins while it starts.
                .disabled(draft.projectId == nil || client?.canOperate != true || sending)
                accessChip
                Spacer(minLength: AceTheme.Spacing.sm)
                ModelEffortChip(provider: choice.agent?.provider, model: modelName, effort: tune,
                                loading: agentsState != "ready" && agentsState != "failed",
                                modelID: "newThread.agent", effortID: "newThread.tune",
                                openModel: chooseModel, openEffort: chooseTune)
                ComposerActionButton(saving: sending, disabled: blocker != nil || sending, label: "Start thread", action: send)
                    .accessibilityHint(blocker ?? "").accessibilityIdentifier("newThread.start")
            }
            .padding(.horizontal, AceTheme.Spacing.sm)
        }
    }
    private var modelName: String { choice.model?.label ?? (agentsState == "failed" ? "Couldn't read agents" : "Choose model") }
    private var tune: String? {
        guard let model = choice.model else { return nil }
        let speeds = model.speeds ?? []
        let effort = model.efforts.first { $0.id == choice.effort }
        let speedID = draft.speed ?? model.defaultSpeed ?? "standard"
        let speed = speeds.first { $0.speed == speedID && $0.speed != "standard" }
        return TuneSummary.text(effort: effort.map { short($0.label) }, speed: speed?.label,
                                hasLevels: model.efforts.count > 1, hasSpeeds: speeds.count > 1)
    }
    /// "Medium" reads "Med" on the chip, as the thread composer's does.
    private func short(_ label: String) -> String { label == "Medium" ? "Med" : label }
    /// Access for the chosen agent (`newThreadAccess` in `@ace/ui-core`), with what each mode does.
    @ViewBuilder private var accessChip: some View {
        if let access = client?.compose.access, access.provider == choice.agent?.provider,
           !access.choices.isEmpty || access.state == "loading" {
            AccessChip(label: access.choices.first { $0.mode == access.selected }?.label ?? "Access", selected: access.selected,
                       items: access.choices.map { AccessItem(mode: $0.mode, label: $0.label, description: $0.description, attention: $0.attention) },
                       note: access.problem ?? access.stricter, loading: access.choices.isEmpty,
                       identifier: "newThread.access") { mode in drafts.edit { $0.access = mode } }
        }
    }
}

/// Instructions for the first message, from a saved profile or written here.
struct NewThreadInstructionsView: View {
    let drafts: NewThreadDraftModel
    let profiles: [TaskProfile]
    let reloadProfiles: () -> Void
    private var draft: NewThreadDraft { drafts.draft }
    var body: some View {
        List {
            Section {
                Picker("Profile", selection: Binding(get: { draft.profileId ?? "" }, set: { id in
                    drafts.edit { $0.profileId = id.isEmpty ? nil : id; $0.instructions = profiles.first { $0.id == id }?.instructions }
                })) {
                    Text("None").tag("")
                    ForEach(profiles) { Text($0.name).tag($0.id) }
                }
                .accessibilityIdentifier("newThread.profile")
                TextField("Custom instructions", text: Binding(get: { draft.instructions ?? "" }, set: { value in drafts.edit { $0.instructions = value } }), axis: .vertical)
                    .lineLimit(2...8).accessibilityIdentifier("newThread.instructions")
            } footer: { Text("Included in the thread's first message.") }
            .insetRowBackground()
            Section {
                NavigationLink { TaskProfilesView(store: TaskProfileStore(defaults: .standard)) } label: { InsetRow("Manage profiles", systemImage: "person.text.rectangle") }
                    .accessibilityIdentifier("newThread.profiles")
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .onAppear(perform: reloadProfiles)
        .navigationTitle("Instructions").navigationBarTitleDisplayMode(.inline)
    }
}
