import SwiftUI

/// Where the New thread sheet can go: pickers push, choosing pops back to the start.
enum NewThreadRoute: Hashable { case projects, addProject, mention, instructions }

/// New thread (issue #560): "What should we build in <project>?", then, above the keyboard, the
/// worktree and base chips and the first message with its files and model. The bridge judges
/// readiness and builds `thread.create`; the draft survives the app being killed.
struct NewThreadSheet: View {
    @Bindable var inbox: MachineInbox
    /// The start was saved on this phone under this command id on this machine.
    let saved: (_ machineId: String, _ commandId: String) -> Void
    var initialProject: String? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var drafts = NewThreadDraftModel(store: .standard())
    @State private var path: [NewThreadRoute] = []
    @State private var sending = false
    @State private var failure: String?
    @State private var browsing = false
    @State private var choosingModel = false
    @State private var attachProblem: String?
    @State private var profiles: [TaskProfile] = []
    private var draft: NewThreadDraft { drafts.draft }
    /// The first message's files, in the chosen project's draft scope.
    private var files: [AttachmentFile] {
        guard let read = compose?.attachments, read.workspaceId == draft.projectId else { return [] }
        return read.files
    }
    /// What the bridge needs to know of the draft to order the picker and read access modes.
    private var choiceKey: [String] { [draft.projectId, draft.provider, draft.model, draft.account, draft.access].map { $0 ?? "" } }

    private var machineId: String? {
        if let id = draft.machineId, inbox.client(id) != nil { return id }
        return (inbox.sessions.first { $0.client.canOperate } ?? inbox.sessions.first)?.hostId
    }
    private var client: ClientModel? { machineId.flatMap(inbox.client) }
    private var compose: ComposeModel? { client?.compose }
    private var project: ComposeProject? { compose?.projects.first { $0.id == draft.projectId } }
    private var choice: NewThreadChoice { NewThreadChoice(compose: compose, draft: draft) }
    private var branches: (state: String, bases: [ComposeBase], start: ComposeBaseRef?, noWorktree: String?)? {
        guard let read = compose?.branches, read.workspaceId == draft.projectId else { return nil }
        return (read.state, read.bases, read.start, read.noWorktree)
    }
    private var blocker: String? {
        NewThreadGate.blocker(draft, canOperate: client?.canOperate ?? false, agent: compose?.agentsState == "ready" ? choice.agent : nil, files: files.count,
                              waits: [compose?.attachments?.blocked, compose?.access?.provider == choice.agent?.provider ? compose?.access?.problem : nil])
    }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: AceTheme.Spacing.none) {
                ScrollView { hero }
                    .scrollDismissesKeyboard(.interactively)
                    .defaultScrollAnchor(.top)
                bottom
            }
            .background(AceTheme.Colours.background)
            .onAppear { profiles = TaskProfileStore(defaults: .standard).load() }
            .navigationTitle("New thread").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("newThread.close")
                }
                ToolbarItem(placement: .topBarTrailing) { moreOptions }
            }
            .navigationDestination(for: NewThreadRoute.self) { route in destination(route) }
        }
        .tint(AceTheme.Colours.foreground)
        .task(id: machineId) {
            guard let client else { return }
            if draft.projectId == nil, let initialProject { drafts.edit { $0.projectId = initialProject } }
            client.composeAction(["kind": "open"])
            client.composeChoice(draft)
            if let project = draft.projectId {
                client.composeAction(["kind": "branches", "workspaceId": project])
                // Files kept from before a relaunch or a closed sheet go back on the message; the
                // bridge checks and uploads them again and ignores one it already holds.
                for file in drafts.restorable { client.composeAttach(file, workspaceId: project) }
            }
        }
        .onChange(of: draft.projectId) { _, project in
            if let project { client?.composeAction(["kind": "branches", "workspaceId": project]) }
        }
        .onChange(of: choiceKey) { _, _ in client?.composeChoice(draft) }
        .onDisappear { client?.composeAction(["kind": "close"]) }
        .sheet(isPresented: $browsing) { projectFiles }
        .sheet(isPresented: $choosingModel) {
            if let client {
                NewThreadModelSheet(compose: client.compose, drafts: drafts) { client.composeAction(["kind": "agents"]) }
            }
        }
    }

    /// "What should we build in ace-next?", the project underlined and tappable; the machine
    /// beneath when there's more than one.
    private var hero: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            NavigationLink(value: NewThreadRoute.projects) {
                Group {
                    if let name = project?.name {
                        Text("What should we build in ") + Text(name).underline(color: AceTheme.Colours.decoration) + Text("?")
                    } else {
                        Text("What should we build?\n") + Text("Choose a project").foregroundStyle(AceTheme.Colours.mutedForeground)
                            .underline(color: AceTheme.Colours.decoration)
                    }
                }
                .aceFont(NewThreadStyle.hero, relativeTo: .title)
                .foregroundStyle(AceTheme.Colours.foreground)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(project.map { "Project, \($0.name)" } ?? "Choose a project")
            .accessibilityIdentifier("newThread.project")
            if inbox.sessions.count > 1 {
                Menu {
                    Picker("Machine", selection: Binding(get: { machineId ?? "" }, set: { id in
                        drafts.edit { $0.machineId = id; $0.projectId = nil; $0.provider = nil; $0.model = nil; $0.account = nil; $0.effort = nil; $0.speed = nil; $0.access = nil; $0.base = nil }
                    })) {
                        ForEach(inbox.sessions) { session in
                            Text(session.client.canOperate ? inbox.name(session.hostId) : "\(inbox.name(session.hostId)) · View only").tag(session.hostId)
                        }
                    }
                } label: {
                    Text("on \(machineId.map(inbox.name) ?? "")").aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                .accessibilityLabel("Machine").accessibilityValue(machineId.map(inbox.name) ?? "")
                .accessibilityIdentifier("newThread.machine")
            }
        }
        .padding(.horizontal, AceTheme.Spacing.xxl).padding(.top, AceTheme.Spacing.xxl)
    }

    /// Above the keyboard: what holds Send back, the worktree chips, then the first message.
    private var bottom: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm + AceTheme.Spacing.xxs) {
            if let note = failure ?? attachProblem ?? (draft.text.isEmpty ? nil : blocker) {
                Text(note).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle((failure ?? attachProblem) == nil ? AceTheme.Colours.mutedForeground : AceTheme.StatusText.failed)
                    .padding(.horizontal, AceTheme.Spacing.sm)
                    .accessibilityIdentifier("newThread.note")
            }
            if draft.projectId != nil {
                NewThreadWorktreeChips(drafts: drafts, branches: branches)
            }
            NewThreadComposer(drafts: drafts, client: client, files: files, choice: choice, agentsState: compose?.agentsState,
                              sending: sending, blocker: blocker, attachProblem: $attachProblem,
                              chooseModel: { choosingModel = true }, send: send)
        }
        .padding(.horizontal, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
        .padding(.bottom, AceTheme.Spacing.sm)
    }

    /// Mentions, the project's files, and instructions or a profile, out of the main path.
    private var moreOptions: some View {
        Menu {
            Button("Mention a file", systemImage: "at") { path.append(.mention) }
                .disabled(draft.projectId == nil).accessibilityIdentifier("newThread.mention")
            Button("Browse files", systemImage: "folder") { browsing = true }
                .disabled(draft.projectId == nil).accessibilityIdentifier("newThread.files")
            Button("Instructions and profile", systemImage: "person.text.rectangle") { path.append(.instructions) }
                .accessibilityIdentifier("newThread.instructionsPage")
        } label: { Image(systemName: "ellipsis") }
        .accessibilityLabel("More options").accessibilityIdentifier("newThread.options")
    }
    /// The chosen project's own folder, read-only, before the thread exists.
    @ViewBuilder private var projectFiles: some View {
        if let client, let project = draft.projectId {
            ThreadFilesSheet(model: client, scope: .project(project), mention: { file in drafts.edit { $0.text = Mention.insert(file, into: $0.text) }; browsing = false })
        }
    }
    @ViewBuilder private func destination(_ route: NewThreadRoute) -> some View {
        if let client {
            switch route {
            case .projects:
                ProjectPickerView(compose: client.compose, selected: draft.projectId, canAdd: client.canOperate,
                                  reload: { client.composeAction(["kind": "projects"]) }, addProject: { path.append(.addProject) }) { id in
                    drafts.edit { $0.projectId = id; $0.base = nil }
                    path = []
                }
            case .addProject:
                AddProjectView(client: client) { id in
                    drafts.edit { $0.projectId = id; $0.base = nil }
                    path = []
                }
            case .mention:
                MentionSearchView(compose: client.compose, workspaceId: draft.projectId ?? "", search: { query in
                    client.composeAction(["kind": "mentions", "workspaceId": draft.projectId ?? "", "query": query])
                }) { file in
                    drafts.edit { $0.text = Mention.insert(file, into: $0.text) }
                    path = []
                }
            case .instructions:
                NewThreadInstructionsView(drafts: drafts, profiles: profiles) { profiles = TaskProfileStore(defaults: .standard).load() }
            }
        }
    }
    private func send() {
        guard let client, let machineId, blocker == nil, !sending else { return }
        failure = nil
        // The defaults the bridge suggested become the draft's own choices before it is sent.
        if draft.provider == nil, let agent = choice.agent, let model = choice.model {
            drafts.edit { $0.provider = agent.provider; $0.model = model.key; $0.account = model.account }
        }
        if draft.worktree, draft.base == nil, let start = branches?.start { drafts.edit { $0.base = start } }
        drafts.edit { $0.machineId = machineId }
        let commandId = drafts.reserveCommand { UUID().uuidString.lowercased() }
        let sending = draft
        self.sending = true
        Task {
            let admitted = await client.startThread(sending, commandId: commandId)
            self.sending = false
            if admitted {
                drafts.admitted()
                saved(machineId, commandId)
                dismiss()
            } else {
                failure = client.error ?? "Couldn't save the new thread on this phone. Your draft is still here."
                client.error = nil
            }
        }
    }
}

/// One file picked to mention in a thread's composer; each pick is a new value.
struct ComposerMention: Equatable {
    let id = UUID()
    let path: String
}

/// `@path` as the web's composer inserts it, separated from the words around it.
enum Mention {
    static func insert(_ path: String, into text: String) -> String {
        let token = "@\(path) "
        if text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") { return text + token }
        return text + " " + token
    }
}
