import SwiftUI

/// Where the New thread sheet can go: pickers push, choosing pops back to the form.
enum NewThreadRoute: Hashable { case projects, addProject, agents, mention }

/// New thread (issue #560), as the web's New thread: machine, project (recent first), an
/// optional worktree and its base, the coding agent and model, then the first message. The
/// bridge judges readiness and builds `thread.create`; the draft survives the app being killed.
struct NewThreadSheet: View {
    @Bindable var inbox: MachineInbox
    /// The start was saved on this phone under this command id on this machine.
    let saved: (_ machineId: String, _ commandId: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var drafts = NewThreadDraftModel(store: .standard())
    @State private var path: [NewThreadRoute] = []
    @State private var sending = false
    @State private var failure: String?
    private var draft: NewThreadDraft { drafts.draft }

    private var machineId: String? {
        if let id = draft.machineId, inbox.client(id) != nil { return id }
        return (inbox.sessions.first { $0.client.canOperate } ?? inbox.sessions.first)?.hostId
    }
    private var client: ClientModel? { machineId.flatMap(inbox.client) }
    private var compose: ComposeModel? { client?.compose }
    private var project: ComposeProject? { compose?.projects.first { $0.id == draft.projectId } }
    private var agent: ComposeAgent? {
        let provider = draft.provider ?? compose?.start?.provider
        return compose?.agents.first { $0.provider == provider }
    }
    private var model: ComposeAgent.Model? {
        guard let agent else { return nil }
        let key = draft.provider == agent.provider ? draft.model : compose?.start?.model
        let account = draft.provider == agent.provider ? draft.account : compose?.start?.account
        return agent.models.first { $0.key == key && (account == nil || $0.account == account) } ?? agent.models.first { $0.key == key }
    }
    private var branches: (state: String, bases: [ComposeBase], start: ComposeBaseRef?, noWorktree: String?)? {
        guard let read = compose?.branches, read.workspaceId == draft.projectId else { return nil }
        return (read.state, read.bases, read.start, read.noWorktree)
    }
    private var blocker: String? { NewThreadGate.blocker(draft, canOperate: client?.canOperate ?? false, agent: agentsLoaded ? agent : nil) }
    private var agentsLoaded: Bool { compose?.agentsState == "ready" }

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                if inbox.sessions.count > 1 { machineSection }
                if client?.canOperate == false { ViewOnlyNote(message: NewThreadGate.viewOnly).listRowBackground(Color.clear) }
                projectSection
                agentSection
                messageSection
                if let failure {
                    Text(failure).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.StatusText.failed)
                        .accessibilityIdentifier("newThread.failure")
                }
            }
            .navigationTitle("New thread").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { send() } label: { if sending { ProgressView() } else { Text("Start") } }
                        .disabled(blocker != nil || sending)
                        .accessibilityHint(blocker ?? "")
                        .accessibilityIdentifier("newThread.start")
                }
            }
            .navigationDestination(for: NewThreadRoute.self) { route in destination(route) }
        }
        .task(id: machineId) {
            guard let client else { return }
            client.composeAction(["kind": "open"])
            if let project = draft.projectId { client.composeAction(["kind": "branches", "workspaceId": project]) }
        }
        .onChange(of: draft.projectId) { _, project in
            if let project { client?.composeAction(["kind": "branches", "workspaceId": project]) }
        }
        .onDisappear { client?.composeAction(["kind": "close"]) }
    }

    private var machineSection: some View {
        Section {
            Picker("Machine", selection: Binding(get: { machineId ?? "" }, set: { id in
                drafts.edit { $0.machineId = id; $0.projectId = nil; $0.provider = nil; $0.model = nil; $0.account = nil; $0.effort = nil; $0.base = nil }
            })) {
                ForEach(inbox.sessions) { session in
                    Text(session.client.canOperate ? inbox.name(session.hostId) : "\(inbox.name(session.hostId)) · View only").tag(session.hostId)
                }
            }
            .accessibilityIdentifier("newThread.machine")
        }
    }
    private var projectSection: some View {
        Section {
            NavigationLink(value: NewThreadRoute.projects) {
                LabeledContent("Project") {
                    Text(project?.name ?? (draft.projectId == nil ? "Choose" : "…")).foregroundStyle(project == nil ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                }
            }
            .accessibilityIdentifier("newThread.project")
            if draft.projectId != nil {
                Toggle("New worktree", isOn: Binding(get: { draft.worktree && branches?.noWorktree == nil }, set: { on in drafts.edit { $0.worktree = on } }))
                    .disabled(branches?.noWorktree != nil || branches?.state != "ready")
                    .accessibilityIdentifier("newThread.worktree")
                if let reason = branches?.noWorktree {
                    Text(reason).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                } else if draft.worktree, let branches, !branches.bases.isEmpty {
                    Picker("Starts from", selection: Binding(get: { draft.base ?? branches.start }, set: { base in drafts.edit { $0.base = base } })) {
                        ForEach(branches.bases) { base in
                            Text(base.note.map { "\(base.label) · \($0)" } ?? base.label).tag(Optional(ComposeBaseRef(ref: base.ref, remote: base.remote)))
                        }
                    }
                    .accessibilityIdentifier("newThread.base")
                }
            }
        } footer: {
            if draft.worktree && branches?.noWorktree == nil { Text("The thread works on a new branch in its own folder, apart from your checkout.") }
        }
    }
    private var agentSection: some View {
        Section {
            NavigationLink(value: NewThreadRoute.agents) {
                LabeledContent(agent?.name ?? "Coding agent") {
                    if !agentsLoaded && compose?.agentsState != "failed" { ProgressView() }
                    else { Text(model?.label ?? (compose?.agentsState == "failed" ? "Couldn't read" : "Choose")).foregroundStyle(AceTheme.Colours.mutedForeground) }
                }
            }
            .accessibilityIdentifier("newThread.agent")
            if let agent, !agent.ready, let reason = agent.reason {
                Text(reason).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.StatusText.needsYou)
            }
            if let model, model.efforts.count > 1 {
                Picker("Reasoning", selection: Binding(get: { draft.effort ?? (draft.model == nil ? compose?.start?.effort : nil) ?? model.defaultEffort ?? "" }, set: { effort in
                    drafts.edit { $0.provider = agent?.provider; $0.model = model.key; $0.account = model.account; $0.effort = effort }
                })) {
                    ForEach(model.efforts) { effort in Text(effort.label).tag(effort.id) }
                }
            }
        }
    }
    private var messageSection: some View {
        Section {
            TextField("What should it do?", text: Binding(get: { draft.text }, set: { text in drafts.edit { $0.text = text } }), axis: .vertical)
                .lineLimit(4...12)
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .accessibilityIdentifier("newThread.message")
            NavigationLink(value: NewThreadRoute.mention) { Label("Mention a file", systemImage: "at") }
                .disabled(draft.projectId == nil)
                .accessibilityIdentifier("newThread.mention")
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
            case .agents:
                AgentPickerView(compose: client.compose, selected: model.map { (agent?.provider ?? "", $0.key, $0.account) },
                                reload: { client.composeAction(["kind": "agents"]) }) { agent, model in
                    drafts.edit { $0.provider = agent.provider; $0.model = model.key; $0.account = model.account; $0.effort = nil }
                    path = []
                }
            case .mention:
                MentionSearchView(compose: client.compose, workspaceId: draft.projectId ?? "", search: { query in
                    client.composeAction(["kind": "mentions", "workspaceId": draft.projectId ?? "", "query": query])
                }) { file in
                    drafts.edit { $0.text = Mention.insert(file, into: $0.text) }
                    path = []
                }
            }
        }
    }
    private func send() {
        guard let client, let machineId, blocker == nil, !sending else { return }
        failure = nil
        // The defaults the bridge suggested become the draft's own choices before it is sent.
        if draft.provider == nil, let agent, let model { drafts.edit { $0.provider = agent.provider; $0.model = model.key; $0.account = model.account } }
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
