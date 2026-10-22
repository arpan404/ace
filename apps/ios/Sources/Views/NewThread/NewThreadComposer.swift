import SwiftUI

@MainActor enum NewThreadStyle {
    /// "What should we build in ace?": large, regular, muted, with the project at full ink.
    static let hero = AceTheme.TypeStyle(size: 26, lineHeight: 32, weight: 400, tracking: -0.4)
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
    private var effort: String? { choice.model?.efforts.first { $0.id == choice.effort }?.label }

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
                    AceIcon(.plus, size: 20).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                .disabled(draft.projectId == nil || client?.canOperate != true)
                Button(action: chooseModel) { modelLabel }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Model").accessibilityValue([choice.model?.label ?? "Choose model", effort].compactMap { $0 }.joined(separator: ", "))
                    .accessibilityIdentifier("newThread.agent")
                Spacer(minLength: AceTheme.Spacing.sm)
                ComposerActionButton(saving: sending, disabled: blocker != nil || sending, label: "Start thread", action: send)
                    .accessibilityHint(blocker ?? "").accessibilityIdentifier("newThread.start")
            }
            .padding(.horizontal, AceTheme.Spacing.sm)
        }
    }
    /// "✳ Opus 5.5 · Med ⌄": the provider's mark, the model at full ink and the effort muted.
    private var modelLabel: some View {
        HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
            if let agent = choice.agent { ProviderMark(provider: agent.provider, size: 16) }
            if agentsState != "ready" && agentsState != "failed" {
                Capsule().fill(AceTheme.Colours.fill).frame(width: 64, height: 10).accessibilityHidden(true)
            } else {
                Text(choice.model?.label ?? (agentsState == "failed" ? "Couldn't read agents" : "Choose model"))
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .lineLimit(1).truncationMode(.middle)
            }
            if let effort { Text("· \(effort)").lineLimit(1) }
            AceIcon(.caretDown, size: 11).foregroundStyle(AceTheme.Colours.subtleForeground)
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
            } header: { SettingsHeader("Instructions", note: "Included in the thread's first message.") }
            .settingsRow()
            Section {
                NavigationLink { TaskProfilesView(store: TaskProfileStore(defaults: .standard)) } label: { SettingsRow("Manage profiles") }
                    .accessibilityIdentifier("newThread.profiles")
            }
            .settingsRow()
        }
        .settingsList()
        .onAppear(perform: reloadProfiles)
        .navigationTitle("Instructions").navigationBarTitleDisplayMode(.inline)
    }
}
