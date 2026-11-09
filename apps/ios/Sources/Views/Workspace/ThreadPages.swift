import Foundation

/// One page of a thread on a phone, a swipe apart: the conversation, and its changes. The
/// thread's other screens (Files, Terminal, Browser, Agents) are pushed from its ⋯ menu.
enum ThreadPageKind: String, CaseIterable, Identifiable, Sendable {
    case chat, changes
    var id: String { rawValue }

    var title: String {
        switch self {
        case .chat: "Chat"
        case .changes: "Changes"
        }
    }
}

/// What a thread has right now, as the daemon reports it: which pages it gets.
struct ThreadPageFacts: Equatable, Sendable {
    /// A chat (ADR 0099) has no checkout: no Changes, Files or Terminal.
    var chat = false
    /// Files changed in its checkout, when the daemon counted them.
    var changedFiles = 0
    /// The page the person asked for (a command, a deep link, a bar button): it stays while it
    /// shows, so committing the last change doesn't bounce the person back to Chat mid-read.
    var requested: ThreadPageKind?
}

/// The pages a thread offers, in the bar's order, and where the person is among them. Changes
/// shows only when the thread has changes; Chat is always first.
struct ThreadPages: Equatable, Sendable {
    let kinds: [ThreadPageKind]
    let changedFiles: Int
    /// The thread has a checkout: Files and Terminal are there to open.
    let checkout: Bool

    init(_ facts: ThreadPageFacts) {
        changedFiles = facts.changedFiles
        checkout = !facts.chat
        kinds = ThreadPageKind.allCases.filter { kind in
            if kind == facts.requested { return true }
            switch kind {
            case .chat: return true
            case .changes: return !facts.chat && facts.changedFiles > 0
            }
        }
    }

    /// The page shown for a selection: itself while the thread has it, otherwise Chat (the
    /// changes committed).
    func shown(_ selected: ThreadPageKind) -> ThreadPageKind {
        kinds.contains(selected) ? selected : .chat
    }

    /// The page's words for VoiceOver: "Changes, 6 files".
    func label(of kind: ThreadPageKind) -> String {
        guard kind == .changes, changedFiles > 0 else { return kind.title }
        return "\(kind.title), \(changedFiles) \(changedFiles == 1 ? "file" : "files")"
    }
}

/// A thread screen a phone pushes over the thread from its ⋯ menu.
enum ThreadPushedTool: String, Identifiable, Sendable {
    case files, terminal, browser, agents
    var id: String { rawValue }
}

extension ThreadDestination {
    /// The page this opens as on a phone; nil for what opens over the thread.
    var page: ThreadPageKind? { self == .changes ? .changes : nil }

    /// The screen a phone pushes for this; nil for what isn't one.
    var pushed: ThreadPushedTool? {
        switch self {
        case .files: .files
        case .terminal: .terminal
        case .browser: .browser
        case .agents: .agents
        default: nil
        }
    }
}
