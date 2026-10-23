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

/// The first message: its files, the words, then + · provider mark and model ⌄ · send.
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
    let send: () -> Void
    private var draft: NewThreadDraft { drafts.draft }

    var body: some View {
        ComposerSurface {
            if !files.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        ForEach(files) { file in AttachmentChip(file: file) { client?.composeDetach(file.id); drafts.remove(file.id) } }
                    }
                    .padding(.horizontal, AceTheme.Spacing.md)
                }
            }
            // The thread composer's text view: it wraps and grows to five lines, then scrolls.
            NativeTextInput(text: Binding(get: { draft.text }, set: { text in drafts.edit { $0.text = text } }), inputBegan: {},
                            submit: { if blocker == nil && !sending { send() } }, identifier: "newThread.message", focusOnAppear: true)
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
                }, problem: $attachProblem, identifier: "newThread.attach", staging: drafts.staging) {
                    Image(systemName: "plus").font(.title3).foregroundStyle(AceTheme.Colours.foreground)
                }
                .disabled(draft.projectId == nil || client?.canOperate != true)
                Button(action: chooseModel) { modelLabel }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Model").accessibilityValue(choice.model?.label ?? "Choose model")
                    .accessibilityIdentifier("newThread.agent")
                Spacer(minLength: AceTheme.Spacing.sm)
                ComposerActionButton(saving: sending, disabled: blocker != nil || sending, label: "Start thread", action: send)
                    .accessibilityHint(blocker ?? "").accessibilityIdentifier("newThread.start")
            }
            .padding(.horizontal, AceTheme.Spacing.sm)
        }
    }
    private var modelLabel: some View {
        HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
            if let agent = choice.agent { ProviderMark(provider: agent.provider, size: 16) }
            if agentsState != "ready" && agentsState != "failed" { ProgressView().controlSize(.mini) }
            Text(choice.model?.label ?? (agentsState == "failed" ? "Couldn't read agents" : "Choose model"))
                .lineLimit(1).truncationMode(.middle)
            Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .contentShape(Rectangle())
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
