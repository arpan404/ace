import SwiftUI

/// Where the New thread sheet pushes; choosing a mention pops back to the start.
enum NewThreadRoute: Hashable { case mention, instructions }

/// New thread: a system sheet with the keyboard up at once. Cancel and its name; the choices as
/// pills (project, machine when there's more than one, model and effort, where it runs, access);
/// the words, taking the sheet's height; suggestions; then + · mic · Send. The bridge judges
/// readiness and builds `thread.create`; the draft survives the app being killed, and Send closes
/// the sheet only once the start is saved on this phone.
struct NewThreadSheet: View {
    @Bindable var inbox: MachineInbox
    /// The draft, opened once for this showing of the sheet (`NewThreadSheetHost`).
    let drafts: NewThreadDraftModel
    /// The start was saved on this phone under this command id on this machine.
    let saved: (_ machineId: String, _ commandId: String) -> Void
    var initialProject: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    /// The machine started on last, each machine's last project and model, and each project's
    /// last picks and skills.
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
    @State private var screenshot: LatestScreenshot?
    @State private var place: CaretPlacement?
    /// Bumped when the remembered picks or skills change, so the suggestions read them again.
    @State private var remembered = 0
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
    /// A handoff asked to start and nothing holds it back.
    private var autoSendReady: Bool { draft.autoSend && blocker == nil && !sending && files.count == draft.files.count }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                pills
                notes
                NewThreadComposer(drafts: drafts, client: client, files: files, sending: sending, blocker: blocker,
                                  attachProblem: $attachProblem, send: send, suggester: suggester, run: runComposerAction,
                                  suggestions: suggestions, pickedSkill: { skill in memory.used(skill, in: draft); remembered += 1 },
                                  place: $place)
                    .task(id: suggestKey) {
                        suggester.attach(client)
                        suggester.scope = draft.projectId.flatMap { $0 == NewThreadDraft.chat ? nil : .draft(workspaceId: $0, provider: choice.agent?.provider) }
                        suggester.readAhead()
                    }
            }
            .background(AceTheme.Colours.background)
            .onAppear {
                profiles = TaskProfileStore(defaults: .standard).load()
                screenshot = LatestScreenshot.read(now: Date())
            }
            .navigationTitle(draft.isChat ? "New chat" : "New thread").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.accessibilityIdentifier("newThread.close")
                }
                ToolbarItem(placement: .topBarTrailing) { moreOptions }
            }
            .navigationDestination(for: NewThreadRoute.self) { route in destination(route) }
        }
        .escapeCloses { dismiss() }
        .tint(AceTheme.Colours.foreground)
        .sensoryFeedback(AceDesign.Haptic.send, trigger: sending) { _, now in now }
        .task(id: machineId) {
            // A start handed over from a share or a shortcut takes the sheet first.
            drafts.takeHandoff { NewThreadHandoffIntake.take(inbox: inbox, into: $0) }
            guard let client, let machineId else { return }
            // The draft holds the machine it opens on, so a later connection doesn't move it. A
            // draft already written on a project before machines were named keeps that project.
            if draft.machineId != machineId {
                if draft.machineId == nil, draft.projectId != nil { drafts.edit { $0.machineId = machineId } }
                else { drafts.edit { $0 = memory.load().open($0, on: machineId) } }
            }
            // New chat always starts a chat, whatever the last draft was in. A handoff keeps its own.
            if let initialProject, draft.handoff == nil, draft.projectId == nil || initialProject == NewThreadDraft.chat {
                drafts.edit { $0 = memory.load().chose(project: initialProject, in: $0) }
            }
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
        .onChange(of: autoSendReady, initial: true) { _, ready in if ready { send() } }
        .onDisappear {
            client?.composeAction(["kind": "close"])
            // Closed before it could start: what was handed over stays as a draft to send by hand.
            if draft.autoSend { drafts.edit { $0.autoSend = false } }
            drafts.leave()
        }
        // Leaving the app saves what was typed, without waiting for typing to pause.
        .onChange(of: scenePhase) { _, phase in if phase != .active { drafts.leave() } }
        .sheet(isPresented: $browsing) { projectFiles }
        .sheet(isPresented: $choosingProject) {
            if let client {
                ProjectPickerSheet(client: client, selected: draft.projectId) { id in
                    drafts.edit { $0 = memory.load().chose(project: id, in: $0) }
                }
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

    /// The start's choices, under the title.
    private var pills: some View {
        NewThreadPills(model: pillsModel, chooseProject: { choosingProject = true }, chooseMachine: chooseMachine,
                       chooseModel: { choosingModel = true }, chooseTune: { choosingTune = true },
                       chooseWorktree: { on in drafts.edit { $0.worktree = on } },
                       chooseBase: { base in drafts.edit { $0.base = base } },
                       chooseAccess: { mode in drafts.edit { $0.access = mode } })
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.top, AceDesign.Space.tight)
    }
    private var pillsModel: NewThreadPillsModel {
        let projectName = draft.isChat ? "No project" : project?.name ?? (draft.projectId == nil ? "Choose a project" : "Project")
        let loading = compose?.agentsState != "ready" && compose?.agentsState != "failed"
        let modelName = choice.model?.label ?? (compose?.agentsState == "failed" ? "Couldn't read agents" : loading ? "Model" : "Choose model")
        var place: NewThreadPillsModel.Place?
        if draft.projectId != nil, !draft.isChat, draft.pullRequest == nil {
            place = .init(worktree: draft.worktree, noWorktree: branches?.noWorktree, reading: branches?.state != "ready",
                          bases: branches?.bases ?? [], base: draft.base ?? branches?.start)
        }
        let access = compose?.access.flatMap { $0.provider == choice.agent?.provider ? $0 : nil }
        return NewThreadPillsModel(
            project: projectName,
            machines: inbox.sessions.map { .init(id: $0.hostId, name: inbox.name($0.hostId), canOperate: $0.client.canOperate) },
            machineId: machineId, provider: choice.agent?.provider, model: modelName, loadingModel: loading,
            tune: tune, tunable: (choice.model?.efforts.count ?? 0) > 1 || (choice.model?.speeds ?? []).count > 1,
            place: place, access: access)
    }
    /// That machine's last project and model come back, as the web's do.
    private func chooseMachine(_ id: String) {
        guard id != machineId else { return }
        drafts.edit { $0 = memory.load().open($0, on: id) }
        memory.remember(draft)
    }
    /// The effort part of the model pill: the level in brief and a speed other than standard.
    /// Nothing at all rather than a word that says nothing ("Default") when no level is known.
    private var tune: String? {
        guard let model = choice.model else { return nil }
        let effort = model.efforts.count > 1 ? model.efforts.first { $0.id == choice.effort }.map { $0.label == "Medium" ? "Med" : $0.label } : nil
        let speedID = draft.speed ?? model.defaultSpeed ?? "standard"
        let speed = (model.speeds ?? []).first { $0.speed == speedID && $0.speed != "standard" }?.label
        let parts = [effort, speed].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// What holds Send back, why the last start didn't save, and the issue or pull request the
    /// thread works on: quiet lines under the pills.
    @ViewBuilder private var notes: some View {
        // A blocker a pill already says ("Choose a project") isn't said twice.
        let said = blocker == "Choose a project" || blocker == "Choose a coding agent" || blocker == "Write the first message"
        let note = failure ?? attachProblem ?? (draft.text.isEmpty && !draft.autoSend || said ? nil : blocker)
        if note != nil || draft.issue != nil || draft.pullRequest != nil {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                if let note {
                    Text(note)
                        .foregroundStyle((failure ?? attachProblem) == nil ? AceTheme.Colours.mutedForeground : AceTheme.StatusText.failed)
                        .accessibilityIdentifier("newThread.note")
                }
                if let issue = draft.issue {
                    linked(Text(verbatim: "From issue #\(issue.number) \(issue.title)"), id: "newThread.issue") { drafts.edit { $0.issue = nil } }
                }
                if let pull = draft.pullRequest {
                    linked(Text(verbatim: "On pull request #\(pull.number) \(pull.title)"), id: "newThread.pull") { drafts.edit { $0.pullRequest = nil } }
                }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.top, AceDesign.Space.tight)
        }
    }
    private func linked(_ text: Text, id: String, unlink: @escaping () -> Void) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            text.lineLimit(1)
            Spacer(minLength: AceDesign.Space.related)
            Button("Unlink", action: unlink).accessibilityIdentifier(id == "newThread.issue" ? "newThread.unlinkIssue" : "newThread.unlinkPull")
        }
        .accessibilityIdentifier(id)
    }

    /// The suggestions row, or nil when nothing in it would do anything.
    private var suggestions: NewThreadSuggestions? {
        _ = remembered
        let kept = memory.load()
        let skills = draft.isChat ? [] : kept.skills(for: draft)
        let offersSkills = !draft.isChat && draft.projectId != nil && choice.agent != nil
        let last = kept.picks(for: draft)
        let sameAsLast = last.map { !$0.matches(draft) } ?? false
        let shot = files.isEmpty && draft.projectId != nil ? screenshot : nil
        guard NewThreadSuggestions.shows(screenshot: shot, skills: skills, offersSkills: offersSkills, sameAsLast: sameAsLast) else { return nil }
        return NewThreadSuggestions(
            screenshot: shot, skills: skills, offersSkills: offersSkills, sameAsLast: sameAsLast,
            attachScreenshot: attach, pickSkill: { skill in
                memory.used(skill, in: draft); remembered += 1
                suggester.choose(skill.row, text: Binding(get: { draft.text }, set: { text in drafts.edit { $0.text = text } }),
                                 place: $place, keep: { drafts.add($0) }, notice: { failure = $0 }, run: runComposerAction)
            },
            openSkills: {
                let lead = draft.text.isEmpty || draft.text.hasSuffix(" ") || draft.text.hasSuffix("\n") ? draft.text : draft.text + " "
                drafts.edit { $0.text = lead + "/" }
                place = CaretPlacement(offset: (draft.text as NSString).length, focus: true)
            },
            restoreLast: { if let last { drafts.edit { $0 = last.applied(to: $0) } } })
    }
    /// The screenshot goes on the message like a photo picked with +.
    private func attach(_ shot: LatestScreenshot) {
        guard let client, let project = draft.projectId else { return }
        screenshot = nil
        Task<Void, Never> {
            guard let picture = await shot.data(),
                  let staged = try? drafts.staging.stage(data: picture.data, name: picture.name, mimeType: picture.mimeType) else {
                attachProblem = "Couldn't read that screenshot."
                return
            }
            drafts.picked(staged, workspaceId: project)
            client.composeAttach(staged, workspaceId: project)
        }
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
        memory.started(draft)
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
                // A refused handoff waits for the person: it no longer starts by itself.
                if draft.autoSend { drafts.edit { $0.autoSend = false } }
                failure = client.error ?? "Couldn't save the new thread on this phone. Your draft is still here."
                client.error = nil
            }
        }
    }
}

/// One file (or the browser's shown page) picked to mention in a thread's composer; each pick
/// is a new value.
struct ComposerMention: Equatable {
    let id = UUID()
    let path: String
    /// Source lines picked in the file viewer (1-based, inclusive); nil mentions the whole file.
    var lines: ClosedRange<Int>? = nil
    /// The words the composer inserts after `@`, as the web labels it: `path` or `path:12-20`.
    var written: String { lines.map { "\(path):\($0.lowerBound)-\($0.upperBound)" } ?? path }
    /// "Ask agent about this page": the page's title goes in as a browser tab reference.
    var tab: BrowserViewInfo.Mention? = nil
}

/// `@path` as the web's composer inserts it, separated from the words around it.
enum Mention {
    /// The browser's page as the web's "Ask agent about this page" leaves it: its title, then a
    /// space, and the reference that says which tab it is.
    static func insert(tab: BrowserViewInfo.Mention, into text: String) -> (text: String, pick: ComposerPick) {
        let lead = text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") ? text : text + " "
        let start = (lead as NSString).length
        let label = tab.label
        let pick = ComposerPick(start: start, end: start + (label as NSString).length, label: label, reference: .object([
            "label": .string(label),
            "browserTab": .object(["type": .string("browser_tab"), "tabId": .string(tab.tabId), "url": .string(tab.url), "title": .string(tab.title)]),
        ]))
        return (lead + label + " ", pick)
    }
    static func insert(_ path: String, into text: String) -> String {
        let token = "@\(path) "
        if text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") { return text + token }
        return text + " " + token
    }
}
