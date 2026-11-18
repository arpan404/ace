import Foundation

/// New thread moved to another machine takes that machine's checkout of the project it left
/// (ADR 0180): at once when the machine has listed its projects, else when its list arrives.
/// Only that machine's list, while the draft still holds the project the move gave it, settles
/// a wait; moving on, picking a project, a failed read or a list with no checkout of it ends it.
struct NewThreadProjectMove: Equatable, Sendable {
    /// A move whose machine hadn't listed its projects yet.
    struct Waiting: Equatable, Sendable {
        let machineId: String
        /// The project left, on the machine moved from.
        let left: ComposeProject
        /// The draft's project just after the move; another one means something chose since.
        let projectId: String?
    }
    private var waiting: Waiting?

    /// `before` became `after` on another machine, leaving `left`; that machine's list reads
    /// `state` with `projects`. The checkout to choose now, if any.
    mutating func move(_ before: NewThreadDraft, to after: NewThreadDraft, leaving left: ComposeProject?,
                       state: String, projects: [ComposeProject]) -> String? {
        // Moved on again before the last machine listed: what was left there still counts.
        let carried = waiting.flatMap { $0.machineId == before.machineId && $0.projectId == before.projectId ? $0.left : nil }
        waiting = nil
        guard let machine = after.machineId, let left = left ?? carried, left.logical?.isEmpty == false else { return nil }
        if state == "ready" { return left.sameProject(in: projects)?.id }
        waiting = Waiting(machineId: machine, left: left, projectId: after.projectId)
        return nil
    }

    /// `machine` sent its list as `state` with `projects` while `draft` is open. The checkout to
    /// choose, once; a draft that moved on or took another project ends the wait.
    mutating func listed(_ draft: NewThreadDraft, on machine: String, state: String, projects: [ComposeProject]) -> String? {
        // Another machine's list answers nothing here; it can come late from one moved away from.
        guard let waiting, machine == waiting.machineId else { return nil }
        guard draft.machineId == waiting.machineId, draft.projectId == waiting.projectId else {
            self.waiting = nil
            return nil
        }
        switch state {
        case "ready":
            self.waiting = nil
            return waiting.left.sameProject(in: projects)?.id
        case "failed":
            self.waiting = nil
            return nil
        default:
            return nil
        }
    }

    /// The person picked a project: nothing listed later replaces it.
    mutating func chose() { waiting = nil }
}

@MainActor extension NewThreadProjectMove {
    /// Moves `drafts` to `machine`, leaving `left`: that machine's last project and model come
    /// back, as the web's do, then its checkout of `left`'s logical project when `there`, its
    /// reads, lists one.
    mutating func move(_ drafts: NewThreadDraftModel, to machine: String, leaving left: ComposeProject?,
                       there: ComposeModel?, memory: NewThreadMemoryStore) {
        let before = drafts.draft
        drafts.edit { $0 = memory.load().open($0, on: machine) }
        let same = move(before, to: drafts.draft, leaving: left, state: there?.projectsState ?? "idle", projects: there?.projects ?? [])
        if let same { drafts.edit { $0 = memory.load().chose(project: same, in: $0) } }
    }

    /// `machine`'s reads, `compose`, changed their projects' state while `drafts` is open.
    mutating func listed(_ drafts: NewThreadDraftModel, on machine: String, compose: ComposeModel, memory: NewThreadMemoryStore) {
        guard let same = listed(drafts.draft, on: machine, state: compose.projectsState, projects: compose.projects) else { return }
        drafts.edit { $0 = memory.load().chose(project: same, in: $0) }
    }
}
