import Foundation
import Observation

/// What the New thread sheet holds between launches: the person's choices, words and picked
/// files (local copies in app storage, named by id). It never holds a token or anything read
/// from the Keychain; the machine is named by its host id.
struct NewThreadDraft: Codable, Equatable, Sendable {
    /// "No project" in place of a project id: the bridge starts a chat in a hidden project it
    /// makes for it (ADR 0099).
    static let chat = "chat"
    var machineId: String?
    var projectId: String?
    /// A chat with no project: no branches, worktree or project files.
    var isChat: Bool { projectId == Self.chat }
    var provider: String?
    var model: String?
    var account: String?
    var effort: String?
    /// A speed turned on for the first turn; nil runs at the model's default.
    var speed: String?
    /// An access mode picked for this thread; nil follows the project's and the computer's.
    var access: String?
    var worktree = false
    var base: ComposeBaseRef?
    var text = ""
    /// References picked into `text` from `@` and `/`, in the project they were picked in. Absent
    /// in drafts kept before references were.
    var picks: ComposerPicks?
    var profileId: String?
    var instructions: String?
    /// The command id of a send that may already be saved: sending the same draft again replays
    /// that one command instead of starting a second thread. Any edit drops it.
    var commandId: String?
    /// Files picked for the first message, each in the project it was picked for.
    var files: [NewThreadFile] = []
    /// The GitHub issue the thread works on (started from an issue's page); it goes with the
    /// project it was picked in.
    var issue: NewThreadIssue?
    /// The pull request the thread works on (started from its page): the thread opens in a
    /// worktree of the PR's head shown there. It goes with the project it was picked in.
    var pullRequest: NewThreadPull?
    /// The handoff (a share, Siri or Shortcuts) this draft came from: it leaves the queue once
    /// the start is saved, whatever the person changed meanwhile.
    var handoff: String?
    /// Start as soon as nothing holds Send back: a handoff asked to send. Typing turns it off, so
    /// the person who starts editing finishes with their own Send.
    var autoSend = false
}

extension NewThreadDraft {
    /// Words or files the person would lose if the draft were replaced.
    var hasContent: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty }
}

/// A pull request a new thread starts on, pinned to the head the person saw.
struct NewThreadPull: Codable, Equatable, Sendable {
    let repository: ForgeRepository
    let number: Int
    let headSha: String
    let title: String
    var json: [String: Any] { ["ref": ["repository": repository.json, "number": number], "headSha": headSha] }
}

/// An issue a new thread links, and its title for the sheet to name it.
struct NewThreadIssue: Codable, Equatable, Sendable {
    let repository: ForgeRepository
    let number: Int
    let title: String
    var json: [String: Any] { ["repository": repository.json, "number": number] }
}

/// The draft as a small JSON file, written atomically and protected until first unlock, with its
/// picked files' copies in a folder beside it.
struct NewThreadDraftStore: Sendable {
    let url: URL
    var files: AttachmentStaging { AttachmentStaging(root: url.deletingPathExtension().appendingPathExtension("files")) }
    static func standard() -> NewThreadDraftStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let store = NewThreadDraftStore(url: base.appendingPathComponent("ace", isDirectory: true).appendingPathComponent("new-thread-draft.json"))
        _ = spikeReset
        return store
    }
    /// Spike launches start New thread empty, as they start thread drafts empty
    /// (`SpikeConfiguration.threadDrafts`), so one UI test's words never reach the next;
    /// `--spike-keep-state` keeps them. Once per process.
    private static let spikeReset: Void = {
        guard SpikeConfiguration.enabled, !ProcessInfo.processInfo.arguments.contains("--spike-keep-state") else { return }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ace", isDirectory: true)
        let store = NewThreadDraftStore(url: base.appendingPathComponent("new-thread-draft.json"))
        for url in [store.url, store.asideURL, store.files.root] { try? FileManager.default.removeItem(at: url) }
    }()
    func load() -> NewThreadDraft {
        DraftFile<NewThreadDraft>(url: url).load() ?? NewThreadDraft()
    }
    /// New thread from an issue: its machine, project, first message and link, keeping the
    /// person's agent and model choices. Files picked for another draft let go when it opens.
    func seed(machineId: String, projectId: String, text: String, issue: NewThreadIssue) {
        var draft = load()
        if draft.machineId != machineId {
            draft.provider = nil; draft.model = nil; draft.account = nil; draft.effort = nil; draft.speed = nil; draft.access = nil
        }
        draft.machineId = machineId
        if draft.projectId != projectId { draft.base = nil }
        draft.projectId = projectId
        draft.text = text
        draft.picks = nil
        draft.issue = issue
        draft.pullRequest = nil
        draft.commandId = nil
        draft.files.removeAll { $0.workspaceId != projectId }
        save(draft)
    }
    /// New thread from a pull request: its machine and project, and the PR whose head the
    /// thread's worktree checks out. The first message is `text`, for the person to read over.
    func seed(machineId: String, projectId: String, pullRequest: NewThreadPull, text: String = "") {
        var draft = load()
        if draft.machineId != machineId {
            draft.provider = nil; draft.model = nil; draft.account = nil; draft.effort = nil; draft.speed = nil; draft.access = nil
        }
        draft.machineId = machineId
        if draft.projectId != projectId { draft.base = nil }
        draft.projectId = projectId
        draft.text = text
        draft.picks = nil
        draft.issue = nil
        draft.pullRequest = pullRequest
        draft.commandId = nil
        draft.files.removeAll { $0.workspaceId != projectId }
        save(draft)
    }
    func save(_ draft: NewThreadDraft) {
        try? DraftFile<NewThreadDraft>(url: url).save(draft)
    }
    /// Drafts waiting while a handoff has the sheet, oldest first: each is set aside whole and
    /// comes back whole, never merged with another.
    private var asideURL: URL { url.deletingPathExtension().appendingPathExtension("aside.json") }
    var aside: [NewThreadDraft] { DraftFile<[NewThreadDraft]>(url: asideURL).load() ?? [] }
    /// A handoff takes the sheet. Whatever was there with words or files goes on top of the
    /// drafts set aside, to be sent by hand; it comes back once a start is saved, or when the
    /// sheet next opens empty.
    func seed(_ handoff: NewThreadDraft) {
        let current = load()
        if current.hasContent {
            var kept = current
            kept.commandId = nil
            kept.autoSend = false
            try? DraftFile<[NewThreadDraft]>(url: asideURL).save(aside + [kept])
        }
        save(handoff)
    }
    /// The draft set aside last, taken back.
    func takeAside() -> NewThreadDraft? {
        var kept = aside
        guard let last = kept.popLast() else { return nil }
        if kept.isEmpty { try? FileManager.default.removeItem(at: asideURL) }
        else { try? DraftFile<[NewThreadDraft]>(url: asideURL).save(kept) }
        return last
    }
}

/// The sheet's draft: every change is saved at once, so killing the app loses nothing. A picked
/// file's copy lives as long as the draft names it: removing it, choosing another project or
/// machine, or a saved start lets the copy go.
@MainActor @Observable final class NewThreadDraftModel {
    private(set) var draft: NewThreadDraft
    @ObservationIgnored private let store: NewThreadDraftStore
    init(store: NewThreadDraftStore) {
        self.store = store
        var loaded = store.load()
        // A copy the system or a crash took can't be sent; a copy no draft names is left over.
        let staging = store.files
        loaded.files.removeAll { !staging.holds($0.localId) }
        let aside = store.aside
        staging.sweep(keeping: Set((loaded.files + aside.flatMap(\.files)).map(\.localId)))
        draft = loaded
        // A draft set aside is never hidden behind an empty sheet.
        if !loaded.hasContent, loaded.handoff == nil, let kept = store.takeAside() { commit(kept) }
    }

    /// The draft as saved, after something outside the sheet wrote it (a handoff).
    func reload() { draft = store.load() }
    /// Where the draft is kept.
    var file: NewThreadDraftStore { store }

    func edit(_ change: (inout NewThreadDraft) -> Void) {
        var next = draft
        change(&next)
        next.commandId = draft.commandId
        // Files, picks and the issue go with the project they were picked for.
        next.files.removeAll { $0.workspaceId != next.projectId }
        if next.text != draft.text { next.autoSend = false }
        if next.projectId != draft.projectId { next.issue = nil; next.pullRequest = nil; next.picks = nil }
        else if next.text != draft.text, var picks = next.picks {
            picks.edited(from: draft.text, to: next.text)
            next.picks = picks.isEmpty ? nil : picks
        }
        guard next != draft else { return }
        next.commandId = nil
        commit(next)
    }
    /// Where the sheet stages a file picked for the first message.
    var staging: AttachmentStaging { store.files }
    /// A file staged in `staging` for `workspaceId`'s first message.
    func picked(_ file: StagedAttachment, workspaceId: String) {
        edit { $0.files.append(NewThreadFile(file, workspaceId: workspaceId)) }
    }
    /// A reference picked into the words, after the edit that inserted them.
    func add(_ pick: ComposerPick) {
        edit { var picks = $0.picks ?? ComposerPicks(); picks.add(pick); $0.picks = picks }
    }
    func remove(_ localId: String) { edit { $0.files.removeAll { $0.localId == localId } } }
    /// The chosen project's files as the bridge takes them, to put back on the message.
    var restorable: [StagedAttachment] { draft.files.filter { $0.workspaceId == draft.projectId }.map(\.staged) }
    /// The id this send goes out under, saved before it is dispatched.
    func reserveCommand(make: () -> String) -> String {
        if let id = draft.commandId { return id }
        let id = make()
        draft.commandId = id
        store.save(draft)
        return id
    }
    /// The start was saved by the SDK with its files already uploaded: the words and files go,
    /// the choices stay for the next thread.
    func admitted() {
        var next = draft
        next.text = ""
        next.picks = nil
        next.commandId = nil
        next.files = []
        next.issue = nil
        next.pullRequest = nil
        next.handoff = nil
        next.autoSend = false
        // A start is saved: the draft set aside last comes back as the person left it.
        if let kept = store.takeAside() { next = kept }
        commit(next)
    }
    /// Saves the draft first, then lets go of the copies it no longer names.
    private func commit(_ next: NewThreadDraft) {
        let dropped = Set(draft.files.map(\.localId)).subtracting(next.files.map(\.localId))
        draft = next
        store.save(next)
        for localId in dropped { store.files.discard(localId) }
    }
}

/// Why Send is unavailable, in the order a person would fix it; nil when it can go. The bridge
/// checks the agent again before anything is saved.
enum NewThreadGate {
    static let viewOnly = "View only. Start threads on your computer, or pair this phone with View and act."
    /// `files` are the first message's attachments and `waits` what the bridge said holds Send
    /// back (files still uploading, an access mode the agent can't run); a message of only files
    /// can go.
    static func blocker(_ draft: NewThreadDraft, canOperate: Bool, agent: ComposeAgent?, files: Int = 0, waits: [String?] = []) -> String? {
        if !canOperate { return viewOnly }
        if draft.projectId == nil { return "Choose a project" }
        if let agent, !agent.ready { return agent.reason ?? "\(agent.name) isn't ready" }
        if agent == nil { return "Choose a coding agent" }
        if files == 0, draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Write the first message" }
        return waits.lazy.compactMap { $0 }.first
    }
}
