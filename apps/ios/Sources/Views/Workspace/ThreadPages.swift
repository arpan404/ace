import Foundation

/// One page of a thread on a phone: the conversation, and each of the web's side panels.
enum ThreadPageKind: String, CaseIterable, Identifiable, Sendable {
    case chat, changes, files, terminal, browser, agents
    var id: String { rawValue }

    var title: String {
        switch self {
        case .chat: "Chat"
        case .changes: "Changes"
        case .files: "Files"
        case .terminal: "Terminal"
        case .browser: "Browser"
        case .agents: "Agents"
        }
    }
}

/// What a thread has right now, as the daemon reports it: which pages it gets.
struct ThreadPageFacts: Equatable, Sendable {
    /// A chat (ADR 0099) has no checkout: no Changes, Files or Terminal.
    var chat = false
    /// Files changed in its checkout, when the daemon counted them.
    var changedFiles = 0
    var hasBrowser = false
    /// Agents in the tree, the main agent included.
    var agents = 1
    /// The page the person asked for (a command, a deep link, a pill): it stays while it shows,
    /// so a browser that is still opening doesn't bounce the person back to Chat.
    var requested: ThreadPageKind?
}

/// The pages a thread offers, in the pill row's order, and where the person is among them.
/// A page shows only when the thread has something for it; Chat is always first.
struct ThreadPages: Equatable, Sendable {
    let kinds: [ThreadPageKind]
    let changedFiles: Int

    init(_ facts: ThreadPageFacts) {
        changedFiles = facts.changedFiles
        kinds = ThreadPageKind.allCases.filter { kind in
            if kind == facts.requested { return true }
            switch kind {
            case .chat: return true
            case .changes: return !facts.chat && facts.changedFiles > 0
            case .files, .terminal: return !facts.chat
            case .browser: return facts.hasBrowser
            case .agents: return facts.agents > 1
            }
        }
    }

    /// The page shown for a selection: itself while the thread has it, otherwise Chat (a
    /// browser closed, the changes committed).
    func shown(_ selected: ThreadPageKind) -> ThreadPageKind {
        kinds.contains(selected) ? selected : .chat
    }

    /// The page beside `page`, a step to the left (-1) or right (1); nil at either end.
    func neighbour(of page: ThreadPageKind, step: Int) -> ThreadPageKind? {
        guard let index = kinds.firstIndex(of: page), kinds.indices.contains(index + step) else { return nil }
        return kinds[index + step]
    }

    /// The pill's words for VoiceOver and its count: "Changes, 6 files".
    func count(of kind: ThreadPageKind) -> Int? {
        kind == .changes && changedFiles > 0 ? changedFiles : nil
    }
}

extension ThreadDestination {
    /// The page this opens as on a phone; nil for what still opens over the thread.
    var page: ThreadPageKind? {
        switch self {
        case .changes: .changes
        case .files: .files
        case .terminal: .terminal
        case .browser: .browser
        case .agents: .agents
        default: nil
        }
    }
}
