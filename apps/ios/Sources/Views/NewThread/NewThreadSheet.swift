import SwiftUI

/// Where the New thread sheet pushes; choosing a mention pops back to the start.
enum NewThreadRoute: Hashable { case mention, instructions }

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
    /// The machine started on last and each machine's last project and model.
    private let memory = NewThreadMemoryStore.standard()
    @State private var path: [NewThreadRoute] = []
    @State private var sending = false
    @State private var failure: String?
    @State private var browsing = false
    @State private var choosingModel = false
    @State private var choosingTune = false
    @State private var choosingProject = false
    @State private var attachProblem: String?
    @State private var profiles: [TaskProfile] = []
    /// The first message's `@`, `/` and + lists, in the chosen project with the chosen agent.
    @State private var suggester = ComposerSuggester()
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
        let options = inbox.sessions.map { session in
            NewThreadMachineOption(hostId: session.hostId, name: inbox.name(session.hostId), canOperate: session.client.canOperate,
                                   connection: session.client.connection)
        }
        return NewThreadMemory.machine(options, remembered: memory.load().machine)
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
        .escapeCloses { dismiss() }
        .tint(AceTheme.Colours.foreground)
        .task(id: machineId) {
            guard let client, let machineId else { return }
            // The draft holds the machine it opens on, so a later connection doesn't move it. A
            // draft already written on a project before machines were named keeps that project.
            if draft.machineId != machineId {
                if draft.machineId == nil, draft.projectId != nil { drafts.edit { $0.machineId = machineId } }
                else { drafts.edit { $0 = memory.load().open($0, on: machineId) } }
            }
            if draft.projectId == nil, let initialProject { drafts.edit { $0.projectId = initialProject } }
            client.composeAction(["kind": "open"])
            client.composeChoice(draft)
            if let project = draft.projectId {
                if !draft.isChat { client.composeAction(["kind": "branches", "workspaceId": project]) }
                // Files kept from before a relaunch or a closed sheet go back on the message; the
                // bridge checks and uploads them again and ignores one it already holds.
                for file in drafts.restorable { client.composeAttach(file, workspaceId: project) }
            }
        }
        .onChange(of: draft.projectId) { _, project in
            if let project, project != NewThreadDraft.chat { client?.composeAction(["kind": "branches", "workspaceId": project]) }
        }
        // With no project yet, the first thread is a chat.
        .onChange(of: compose?.projectsState) { _, state in
            if state == "ready", draft.projectId == nil, compose?.projects.isEmpty == true {
                drafts.edit { $0.projectId = NewThreadDraft.chat }
            }
        }
        .onChange(of: choiceKey) { _, _ in
            client?.composeChoice(draft)
            memory.record(draft)
        }
        .onDisappear { client?.composeAction(["kind": "close"]) }
        .sheet(isPresented: $browsing) { projectFiles }
        .sheet(isPresented: $choosingProject) {
            if let client {
                ProjectPickerSheet(client: client, selected: draft.projectId) { id in drafts.edit { $0.projectId = id; $0.base = nil } }
            }
        }
        .sheet(isPresented: $choosingModel) {
            if let client {
                NewThreadModelSheet(compose: client.compose, drafts: drafts, reload: { client.composeAction(["kind": "agents"]) },
                                    star: { client.composeAction(["kind": "favorite", "key": $0]) })
            }
        }
        .sheet(isPresented: $choosingTune) { NewThreadTunePanel(drafts: drafts, choice: choice) }
    }

    /// "What should we build in ace-next? ⌄": the question opens the project picker; the
    /// machine beneath when there's more than one.
    private var hero: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            Button { choosingProject = true } label: {
                Group {
                    if draft.isChat {
                        // A chat names no project: a plain question, "No project" opens the picker.
                        Text("What should we work on? ")
                            + Text("No project").foregroundStyle(AceTheme.Colours.mutedForeground) + NewThreadStyle.disclosure
                    } else if let name = project?.name {
                        Text("What should we build in \(name)?") + NewThreadStyle.disclosure
                    } else {
                        Text("What should we build?\n")
                            + Text("Choose a project").foregroundStyle(AceTheme.Colours.mutedForeground) + NewThreadStyle.disclosure
                    }
                }
                .aceFont(NewThreadStyle.hero, relativeTo: .title)
                .foregroundStyle(AceTheme.Colours.foreground)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(draft.isChat ? "Project, none" : project.map { "Project, \($0.name)" } ?? "Choose a project")
            .accessibilityIdentifier("newThread.project")
            if inbox.sessions.count > 1 {
                Menu {
                    Picker("Machine", selection: Binding(get: { machineId ?? "" }, set: { id in
                        // That machine's last project and model come back, as the web's do.
                        guard id != machineId else { return }
                        drafts.edit { $0 = memory.load().open($0, on: id) }
                        memory.remember(draft)
                    })) {
                        ForEach(inbox.sessions) { session in
                            Text(session.client.canOperate ? inbox.name(session.hostId) : "\(inbox.name(session.hostId)) · View only").tag(session.hostId)
                        }
                    }
                } label: {
                    (machineLine + Text(" \(Image(systemName: "chevron.down"))").font(.caption.weight(.semibold)))
                        .aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                .accessibilityLabel("Machine").accessibilityValue(machineId.map(inbox.name) ?? "")
                .accessibilityIdentifier("newThread.machine")
            } else if machineId != nil {
                machineLine.aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.xxl).padding(.top, AceTheme.Spacing.xxl)
    }
    private var machineLine: Text { Text("on \(machineId.map(inbox.name) ?? "")") }

    /// Above the keyboard: what holds Send back, the worktree chips, then the first message.
    private var bottom: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm + AceTheme.Spacing.xxs) {
            if let note = failure ?? attachProblem ?? (draft.text.isEmpty ? nil : blocker) {
                Text(note).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle((failure ?? attachProblem) == nil ? AceTheme.Colours.mutedForeground : AceTheme.StatusText.failed)
                    .padding(.horizontal, AceTheme.Spacing.sm)
                    .accessibilityIdentifier("newThread.note")
            }
            if let issue = draft.issue {
                HStack(spacing: AceTheme.Spacing.sm) {
                    Text(verbatim: "From issue #\(issue.number) \(issue.title)").lineLimit(1)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    Button("Unlink") { drafts.edit { $0.issue = nil } }
                        .accessibilityIdentifier("newThread.unlinkIssue")
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .padding(.horizontal, AceTheme.Spacing.sm)
                .accessibilityIdentifier("newThread.issue")
            }
            if draft.projectId != nil, !draft.isChat {
                NewThreadWorktreeChips(drafts: drafts, branches: branches)
            }
            NewThreadComposer(drafts: drafts, client: client, files: files, choice: choice, agentsState: compose?.agentsState,
                              sending: sending, blocker: blocker, attachProblem: $attachProblem,
                              chooseModel: { choosingModel = true }, chooseTune: { choosingTune = true }, send: send,
                              suggester: suggester, run: runComposerAction)
                .task(id: suggestKey) {
                    suggester.attach(client)
                    suggester.scope = draft.projectId.flatMap { $0 == NewThreadDraft.chat ? nil : .draft(workspaceId: $0, provider: choice.agent?.provider) }
                    suggester.readAhead()
                }
        }
        .padding(.horizontal, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
        .padding(.bottom, AceTheme.Spacing.sm)
    }

    /// Mentions, the project's files, and instructions or a profile, out of the main path.
    private var moreOptions: some View {
        Menu {
            Button("Mention a file", systemImage: "at") { path.append(.mention) }
                .disabled(draft.projectId == nil || draft.isChat).accessibilityIdentifier("newThread.mention")
            Button("Browse files", systemImage: "folder") { browsing = true }
                .disabled(draft.projectId == nil || draft.isChat).accessibilityIdentifier("newThread.files")
            Button("Instructions and profile", systemImage: "person.text.rectangle") { path.append(.instructions) }
                .accessibilityIdentifier("newThread.instructionsPage")
        } label: { Image(systemName: "ellipsis") }
        .accessibilityLabel("More options").accessibilityIdentifier("newThread.options")
    }
    /// The chosen project's own folder, read-only, before the thread exists.
    @ViewBuilder private var projectFiles: some View {
        if let client, let project = draft.projectId {
            NavigationStack {
                FilesScreen(model: client, scope: .project(project), subtitle: self.project?.name ?? "",
                            mention: { file in mentionFile(file.path); browsing = false })
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button { browsing = false } label: { Image(systemName: "xmark") }
                                .accessibilityLabel("Close").accessibilityIdentifier("files.close")
                        }
                    }
            }
            .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
    }
    @ViewBuilder private func destination(_ route: NewThreadRoute) -> some View {
        if let client {
            switch route {
            case .mention:
                MentionSearchView(compose: client.compose, workspaceId: draft.projectId ?? "", search: { query in
                    client.composeAction(["kind": "mentions", "workspaceId": draft.projectId ?? "", "query": query])
                }) { file in
                    mentionFile(file)
                    path = []
                }
            case .instructions:
                NewThreadInstructionsView(drafts: drafts, profiles: profiles) { profiles = TaskProfileStore(defaults: .standard).load() }
            }
        }
    }
    /// `@path` at the end of the words, sent as a mention of the file.
    private func mentionFile(_ path: String) {
        drafts.edit { $0.text = Mention.insert(path, into: $0.text) }
        drafts.add(.file(path, endingAt: draft.text))
    }
    /// Where the lists come from: the machine, project and agent.
    private var suggestKey: [String] { [machineId ?? "", draft.projectId ?? "", choice.agent?.provider ?? ""] }
    /// A builtin from the composer's `/` or + list (the bridge lists only these before a thread exists).
    private func runComposerAction(_ action: String) {
        switch action {
        case "plan": drafts.edit { $0.access = "read-only" }
        case "model": choosingModel = true
        case "project": choosingProject = true
        default: break
        }
    }
    private func send() {
        guard let client, let machineId, blocker == nil, !sending else { return }
        failure = nil
        // The defaults the bridge suggested become the draft's own choices before it is sent.
        if draft.provider == nil, let agent = choice.agent, let model = choice.model {
            drafts.edit { $0.provider = agent.provider; $0.model = model.key; $0.account = model.account }
        }
        if draft.isChat { drafts.edit { $0.worktree = false; $0.base = nil } }
        if draft.worktree, draft.base == nil, let start = branches?.start { drafts.edit { $0.base = start } }
        drafts.edit { $0.machineId = machineId }
        memory.remember(draft)
        let commandId = drafts.reserveCommand { UUID().uuidString.lowercased() }
        let sending = draft
        self.sending = true
        Task {
            let admitted = await client.startThread(sending, commandId: commandId, references: sending.picks?.payload ?? [])
            self.sending = false
            if admitted {
                suggester.sent()
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
    /// Source lines picked in the file viewer (1-based, inclusive); nil mentions the whole file.
    var lines: ClosedRange<Int>? = nil
    /// The words the composer inserts after `@`, as the web labels it: `path` or `path:12-20`.
    var written: String { lines.map { "\(path):\($0.lowerBound)-\($0.upperBound)" } ?? path }
}

/// `@path` as the web's composer inserts it, separated from the words around it.
enum Mention {
    static func insert(_ path: String, into text: String) -> String {
        let token = "@\(path) "
        if text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") { return text + token }
        return text + " " + token
    }
}
