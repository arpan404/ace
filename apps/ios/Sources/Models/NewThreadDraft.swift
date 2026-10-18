import Foundation
import Observation

/// What the New thread sheet holds between launches: the person's choices and words. It never
/// holds a token or anything read from the Keychain; the machine is named by its host id.
struct NewThreadDraft: Codable, Equatable, Sendable {
    var machineId: String?
    var projectId: String?
    var provider: String?
    var model: String?
    var account: String?
    var effort: String?
    var worktree = false
    var base: ComposeBaseRef?
    var text = ""
    /// The command id of a send that may already be saved: sending the same draft again replays
    /// that one command instead of starting a second thread. Any edit drops it.
    var commandId: String?
}

/// The draft as a small JSON file, written atomically and protected until first unlock.
struct NewThreadDraftStore: Sendable {
    let url: URL
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

/// The sheet's draft: every change is saved at once, so killing the app loses nothing.
@MainActor @Observable final class NewThreadDraftModel {
    private(set) var draft: NewThreadDraft
    @ObservationIgnored private let store: NewThreadDraftStore
    init(store: NewThreadDraftStore) { self.store = store; draft = store.load() }

    func edit(_ change: (inout NewThreadDraft) -> Void) {
        var next = draft
        change(&next)
        next.commandId = draft.commandId
        guard next != draft else { return }
        next.commandId = nil
        draft = next
        store.save(next)
    }
    /// The id this send goes out under, saved before it is dispatched.
    func reserveCommand(make: () -> String) -> String {
        if let id = draft.commandId { return id }
        let id = make()
        draft.commandId = id
        store.save(draft)
        return id
    }
    /// The start was saved by the SDK: the words go, the choices stay for the next thread.
    func admitted() {
        draft.text = ""
        draft.commandId = nil
        store.save(draft)
    }
}

/// Why Send is unavailable, in the order a person would fix it; nil when it can go. The bridge
/// checks the agent again before anything is saved.
enum NewThreadGate {
    static let viewOnly = "View only. Start threads on your computer, or pair this phone with View and act."
    static func blocker(_ draft: NewThreadDraft, canOperate: Bool, agent: ComposeAgent?) -> String? {
        if !canOperate { return viewOnly }
        if draft.projectId == nil { return "Choose a project" }
        if let agent, !agent.ready { return agent.reason ?? "\(agent.name) isn't ready" }
        if agent == nil { return "Choose a coding agent" }
        if draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Write the first message" }
        return nil
    }
}
