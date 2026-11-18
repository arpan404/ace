import Foundation

/// The project New thread was opened for (a project's New thread, a link, New chat) belongs to
/// the opening: it applies once, on the machine the sheet first reaches. A project id names a
/// project on one machine only, so a later move never takes it to another machine, where
/// `NewThreadProjectMove` finds that machine's own checkout instead.
struct NewThreadOpening: Equatable, Sendable {
    private var reached = false

    /// The sheet reached a machine with `draft` on it; the project to start on, the first time
    /// only. New chat always starts a chat; otherwise a draft with a project, or a handoff,
    /// keeps its own.
    mutating func reach(_ draft: NewThreadDraft, initialProject: String?) -> String? {
        guard !reached else { return nil }
        reached = true
        guard let initialProject, draft.handoff == nil, draft.projectId == nil || initialProject == NewThreadDraft.chat else { return nil }
        return initialProject
    }
}
