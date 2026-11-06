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
/// picked files' copies in a folder beside it. Reads and writes go through `writer`, off the main
/// thread and in order.
struct NewThreadDraftStore: Sendable {
    let url: URL
    var writer = NewThreadDraftWriter.shared
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
        let file = DraftFile<NewThreadDraft>(url: url)
        return writer.run { file.load() } ?? NewThreadDraft()
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
    /// Queues `draft` to be written; `discarding` names copies to let go once it is on disk, so a
    /// crash never leaves a draft naming a copy that is gone.
    func save(_ draft: NewThreadDraft, discarding: Set<String> = []) {
        let file = DraftFile<NewThreadDraft>(url: url)
        let staging = files
        writer.write {
            try? file.save(draft)
            for localId in discarding { staging.discard(localId) }
        }
    }
    /// Drafts waiting while a handoff has the sheet, oldest first: each is set aside whole and
    /// comes back whole, never merged with another.
    private var asideURL: URL { url.deletingPathExtension().appendingPathExtension("aside.json") }
    var aside: [NewThreadDraft] {
        let file = DraftFile<[NewThreadDraft]>(url: asideURL)
        return writer.run { file.load() } ?? []
    }
    /// A handoff takes the sheet. Whatever was there with words or files goes on top of the
    /// drafts set aside, to be sent by hand; it comes back once a start is saved, or when the
    /// sheet next opens empty.
    func seed(_ handoff: NewThreadDraft) {
        let current = load()
        if current.hasContent {
            var kept = current
            kept.commandId = nil
            kept.autoSend = false
            let file = DraftFile<[NewThreadDraft]>(url: asideURL)
            let waiting = aside
            writer.run { try? file.save(waiting + [kept]) }
        }
        save(handoff)
    }
    /// The draft set aside last, taken back.
    func takeAside() -> NewThreadDraft? {
        var kept = aside
        guard let last = kept.popLast() else { return nil }
        let url = asideURL, rest = kept
        writer.run {
            if rest.isEmpty { try? FileManager.default.removeItem(at: url) }
            else { try? DraftFile<[NewThreadDraft]>(url: url).save(rest) }
        }
        return last
    }
}

/// The sheet's draft. Typing is saved once it pauses (and at once when the sheet closes, the app
/// leaves the screen or a handoff takes the sheet); every other change is saved at once. Writes
/// run off the main thread. A picked file's copy lives as long as the draft names it: removing
/// it, choosing another project or machine, or a saved start lets the copy go.
///
/// Making one only reads the draft; `open()` does the sheet's once-per-opening upkeep, so a model
/// SwiftUI makes and throws away changes nothing.
@MainActor @Observable final class NewThreadDraftModel {
    private(set) var draft: NewThreadDraft
    @ObservationIgnored private let store: NewThreadDraftStore
    @ObservationIgnored private let timer: any DraftSaveTimer
    /// Typing not yet handed to the writer.
    @ObservationIgnored private var unsaved = false
    @ObservationIgnored private var opened = false
    init(store: NewThreadDraftStore, timer: any DraftSaveTimer = DraftPauseTimer()) {
        self.store = store
        self.timer = timer
        var loaded = store.load()
        // A copy the system or a crash took can't be sent.
        let staging = store.files
        loaded.files.removeAll { !staging.holds($0.localId) }
        draft = loaded
    }
    /// The sheet opened on this draft: copies no draft names are cleared, and a draft set aside
    /// comes back rather than hiding behind an empty sheet. Only the first call does anything.
    func open() {
        guard !opened else { return }
        opened = true
        let aside = store.aside
        store.files.sweep(keeping: Set((draft.files + aside.flatMap(\.files)).map(\.localId)))
        if !draft.hasContent, draft.handoff == nil, let kept = store.takeAside() { commit(kept) }
    }

    /// A handoff may take the sheet: `take` sees the draft as typed so far, and the sheet then
    /// shows whatever it left there.
    func takeHandoff(_ take: (NewThreadDraftStore) -> Bool) {
        flush()
        if take(store) { draft = store.load() }
    }
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
        guard NewThreadDraftChange.isTyping(from: draft, to: next) else { return commit(next) }
        draft = next
        unsaved = true
        timer.schedule { [weak self] in self?.flush() }
    }
    /// Hands typing not yet saved to the writer now, without waiting for a pause.
    func flush() {
        timer.cancel()
        guard unsaved else { return }
        unsaved = false
        store.save(draft)
    }
    /// The sheet closes or the app leaves the screen: the draft is on disk before this returns.
    func leave() {
        flush()
        store.writer.settle()
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
    /// The id this send goes out under, on disk before it is dispatched.
    func reserveCommand(make: () -> String) -> String {
        if let id = draft.commandId { return id }
        let id = make()
        var next = draft
        next.commandId = id
        commit(next)
        store.writer.settle()
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
    /// Saves the draft, then lets go of the copies it no longer names: a copy let go is gone once
    /// this returns (rare: removing a file, another project, a saved start).
    private func commit(_ next: NewThreadDraft) {
        let dropped = Set(draft.files.map(\.localId)).subtracting(next.files.map(\.localId))
        draft = next
        timer.cancel()
        unsaved = false
        store.save(next, discarding: dropped)
        if !dropped.isEmpty { store.writer.settle() }
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
