import Foundation
import Observation

/// What the New thread sheet holds between launches: the person's choices, words and picked
/// files (local copies in app storage, named by id). It never holds a token or anything read
/// from the Keychain; the machine is named by its host id.
struct NewThreadDraft: Codable, Equatable, Sendable {
    var machineId: String?
    var projectId: String?
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
    var profileId: String?
    var instructions: String?
    /// The command id of a send that may already be saved: sending the same draft again replays
    /// that one command instead of starting a second thread. Any edit drops it.
    var commandId: String?
    /// Files picked for the first message, each in the project it was picked for.
    var files: [NewThreadFile] = []
}

/// The draft as a small JSON file, written atomically and protected until first unlock, with its
/// picked files' copies in a folder beside it.
struct NewThreadDraftStore: Sendable {
    let url: URL
    var files: AttachmentStaging { AttachmentStaging(root: url.deletingPathExtension().appendingPathExtension("files")) }
    static func standard() -> NewThreadDraftStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return NewThreadDraftStore(url: base.appendingPathComponent("ace", isDirectory: true).appendingPathComponent("new-thread-draft.json"))
    }
    func load() -> NewThreadDraft {
        guard let data = try? Data(contentsOf: url), let draft = try? JSONDecoder().decode(NewThreadDraft.self, from: data) else { return NewThreadDraft() }
        return draft
    }
    func save(_ draft: NewThreadDraft) {
        guard let data = try? JSONEncoder().encode(draft) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
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
        staging.sweep(keeping: Set(loaded.files.map(\.localId)))
        draft = loaded
    }

    func edit(_ change: (inout NewThreadDraft) -> Void) {
        var next = draft
        change(&next)
        next.commandId = draft.commandId
        // Files go with the project they were picked for.
        next.files.removeAll { $0.workspaceId != next.projectId }
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
        next.commandId = nil
        next.files = []
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
