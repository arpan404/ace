import SwiftUI

/// The New thread sheet and what follows a start: once the machine's receipt names the new
/// thread and its row arrives, the thread opens. Offline, the start waits in Unsent. The inbox's
/// compose button sets `composing`. Starts asked for outside the app (share sheet, Siri,
/// Shortcuts) open the sheet here, seeded from their handoff.
struct NewThreadEntry: ViewModifier {
    @Bindable var inbox: MachineInbox
    @Binding var composing: Bool
    /// The project the inbox is filtered to, which the sheet starts on.
    let project: String
    let open: (InboxKey) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var awaiting: (machineId: String, commandId: String)?
    /// Why the last start didn't happen, once its receipt said so.
    @State private var refused: String?
    /// The start whose worktree card was shown after Send: shown once, then from its Unsent row.
    @State private var shownCard: String?
    /// The draft as it was sent, kept until its thread exists, so a refusal can give it back.
    @State private var sent: NewThreadDraft?
    /// The refused start's machine and command, for Edit in New thread.
    @State private var refusedStart: (machineId: String, commandId: String)?

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $composing) {
                NewThreadSheetHost(inbox: inbox, saved: { machineId, commandId, draft in
                    awaiting = (machineId, commandId)
                    sent = draft
                }, initialProject: project.isEmpty ? nil : project)
                    .presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .task(id: awaiting?.commandId) {
                guard let awaiting, let client = inbox.client(awaiting.machineId) else { return }
                let id = awaiting.commandId
                // A minute covers a start with nothing to show; a worktree whose card is on screen
                // keeps it waiting for as long as it is being made or offers a way on.
                var idle = 0
                waiting: while idle < 600 {
                    let worktree = client.compose.worktrees[id]
                    // While its card is on screen the card opens the thread itself.
                    let carded = inbox.startCard == InboxKey(machineId: awaiting.machineId, id: id)
                    switch NewThreadWait.next(outcome: client.compose.started[id], worktree: worktree, listed: { client.inbox[$0] != nil }) {
                    case .open(let threadId):
                        if !carded { open(InboxKey(machineId: awaiting.machineId, id: threadId)) }
                        sent = nil
                        break waiting
                    case .refused(let message):
                        refusedStart = awaiting
                        refused = message
                        break waiting
                    case .wait:
                        if worktree?.card != nil, shownCard != id, !composing {
                            shownCard = id
                            inbox.startCard = InboxKey(machineId: awaiting.machineId, id: id)
                        }
                        // A start whose card was put away waits in Unsent, where its row opens it.
                        if worktree?.card == nil || !carded { idle += 1 }
                    }
                    try? await Task.sleep(for: .milliseconds(100))
                    if Task.isCancelled { return }
                }
                self.awaiting = nil
            }
            // The worktree being made, from Send until the thread opens, and again from its
            // Unsent row; Back to New thread opens the sheet on the words it took back.
            .modifier(WorktreeStartSheet(inbox: inbox, open: open) { draft in
                NewThreadDraftStore.standard().seed(draft)
                composing = true
            })
            .alert("The thread didn't start", isPresented: Binding(get: { refused != nil }, set: { if !$0 { refused = nil } })) {
                // The words go back to New thread and the refused start leaves Unsent.
                if sent != nil { Button("Edit in New thread") { editRefused() } }
                Button("Close", role: .cancel) { refused = nil }
            } message: { Text(refused ?? "") }
            // A handoff waits for a machine that can take it and for the sheet to be free.
            .task(id: HandoffWake(active: scenePhase == .active, composing: composing, machines: inbox.sessions.map(\.hostId))) {
                guard scenePhase == .active, !composing else { return }
                readProjects()
                takeHandoff()
            }
            .onChange(of: catalogueKey) { _, _ in writeCatalogue() }
    }

    /// A refused start's draft back in New thread, under a new command id, and out of Unsent.
    private func editRefused() {
        refused = nil
        guard var draft = sent else { return }
        sent = nil
        draft.commandId = nil
        draft.autoSend = false
        draft.handoff = nil
        // Its files went up with the start; the words come back, the files are picked again.
        draft.files = []
        if let start = refusedStart, let client = inbox.client(start.machineId) {
            Task { _ = await client.dismissSend(start.commandId) }
        }
        refusedStart = nil
        NewThreadDraftStore.standard().seed(draft)
        composing = true
    }

    private struct HandoffWake: Equatable { let active: Bool; let composing: Bool; let machines: [String] }

    /// A queued handoff, or a seeded one a relaunch interrupted, opens the sheet, which takes it.
    private func takeHandoff() {
        let current = NewThreadDraftStore.standard().load()
        let resumed = current.autoSend && current.handoff != nil && current.machineId.flatMap(inbox.client) != nil
        if resumed || NewThreadHandoffIntake.ready(inbox: inbox) { composing = true }
    }

    /// Each machine's projects, read once the app is in front, for the share sheet's list.
    private func readProjects() {
        for session in inbox.sessions where session.client.canOperate && session.client.compose.projectsState == "idle" {
            session.client.composeAction(["kind": "projects"])
        }
    }
    private var catalogueKey: [String] {
        inbox.sessions.map { "\($0.hostId):\(inbox.name($0.hostId)):\($0.client.canOperate):\($0.client.compose.projects.map(\.id).joined(separator: ","))" }
    }
    /// What the share sheet and Shortcuts offer: every machine and the projects last read on it.
    private func writeCatalogue() {
        guard let store = HandoffStore.shared() else { return }
        let machines = inbox.sessions.map { session in
            (id: session.hostId, name: inbox.name(session.hostId), canOperate: session.client.canOperate,
             projects: session.client.compose.projectsState == "ready" ? Optional(session.client.compose.projects) : nil)
        }
        store.save(HandoffCatalogue.make(machines: machines, previous: store.catalogue(), memory: NewThreadMemoryStore.standard().load()))
    }
}

/// Moves the oldest queued handoff into New thread's draft (under the handoff's id), once a paired
/// machine can take it. The draft file holds it from then on, so it leaves the queue.
@MainActor enum NewThreadHandoffIntake {
    private static func options(_ inbox: MachineInbox) -> [NewThreadMachineOption] {
        inbox.sessions.map { session in
            NewThreadMachineOption(hostId: session.hostId, name: inbox.name(session.hostId), canOperate: session.client.canOperate,
                                   connection: session.client.connection)
        }
    }
    static func ready(inbox: MachineInbox) -> Bool {
        guard let handoff = HandoffStore.shared()?.pending().first else { return false }
        return NewThreadHandoff.machine(for: handoff, options: options(inbox), remembered: NewThreadMemoryStore.standard().load().machine) != nil
    }
    /// True when the draft now holds a handoff it didn't before.
    static func take(inbox: MachineInbox, into drafts: NewThreadDraftStore) -> Bool {
        // One handoff at a time: the next waits until the one in the sheet is sent or closed.
        let current = drafts.load()
        if current.autoSend, current.handoff != nil { return false }
        guard let store = HandoffStore.shared(), let handoff = store.pending().first else { return false }
        let memory = NewThreadMemoryStore.standard().load()
        guard let machine = NewThreadHandoff.machine(for: handoff, options: options(inbox), remembered: memory.machine) else { return false }
        let staging = drafts.files
        let files = handoff.files.compactMap { file in
            try? staging.stage(copying: store.file(handoff, file), name: file.name, mimeType: file.mimeType)
        }
        drafts.seed(NewThreadHandoff.draft(handoff, on: machine, memory: memory, files: files))
        guard drafts.load().handoff == handoff.id else { return false }
        store.remove(handoff.id)
        return true
    }
}

/// Opens New thread's draft once per showing of the sheet, in `onAppear` rather than in a `@State`
/// initial value: SwiftUI may evaluate that again whenever this view is rebuilt and throw the
/// result away, and opening a draft clears copies and takes back a draft set aside.
private struct NewThreadSheetHost: View {
    @Bindable var inbox: MachineInbox
    let saved: (_ machineId: String, _ commandId: String, _ sent: NewThreadDraft) -> Void
    let initialProject: String?
    @State private var drafts: NewThreadDraftModel?

    var body: some View {
        if let drafts {
            NewThreadSheet(inbox: inbox, drafts: drafts, saved: saved, initialProject: initialProject)
        } else {
            AceTheme.Colours.background.onAppear {
                guard drafts == nil else { return }
                let opened = NewThreadDraftModel(store: .standard())
                opened.open()
                drafts = opened
            }
        }
    }
}

extension View {
    func newThreadEntry(inbox: MachineInbox, composing: Binding<Bool>, project: String, open: @escaping (InboxKey) -> Void) -> some View {
        modifier(NewThreadEntry(inbox: inbox, composing: composing, project: project, open: open))
    }
}

extension MachineInbox {
    /// Starting is impossible when every paired machine is view-only: the compose button stays
    /// out rather than opening a sheet whose Start can never enable.
    var canStartThreads: Bool { sessions.isEmpty || sessions.contains { $0.client.canOperate } }
}
