import Foundation

/// What a project's last thread was started with: the model and its tuning, the access mode and
/// where it ran. New thread puts them back when the project is chosen, and "Same as last time"
/// puts them back after the person changed something.
struct NewThreadPicks: Codable, Equatable, Sendable {
    var provider: String?
    var model: String?
    var account: String?
    var effort: String?
    var speed: String?
    var access: String?
    var worktree = false

    init(_ draft: NewThreadDraft) {
        provider = draft.provider; model = draft.model; account = draft.account
        effort = draft.effort; speed = draft.speed; access = draft.access
        worktree = draft.worktree
    }
    static func key(machine: String, project: String) -> String { machine + "\u{0}" + project }

    /// `draft` with these picks. A chat never runs in a worktree.
    func applied(to draft: NewThreadDraft) -> NewThreadDraft {
        var next = draft
        next.provider = provider; next.model = model; next.account = account
        next.effort = effort; next.speed = speed; next.access = access
        next.worktree = draft.isChat ? false : worktree
        return next
    }
    /// The draft already runs on these picks. Unpicked fields on the draft follow the same
    /// defaults the picks were saved from only when the picks left them unpicked too.
    func matches(_ draft: NewThreadDraft) -> Bool { NewThreadPicks(applied(to: draft)) == NewThreadPicks(draft) }
}

/// A skill picked from `/` into a first message, kept so New thread can offer it again in the same
/// project. Only rows that insert a reference are kept: the reference is the bridge's own, handed
/// back as it was, and the bridge checks it again on send.
struct NewThreadSkill: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let label: String
    let detail: String?
    let icon: String
    let reference: BridgeJSON

    init?(_ row: SuggestionRow) {
        guard row.pick == "reference", row.icon == "skill", let reference = row.reference else { return nil }
        id = row.id; label = row.label; detail = row.detail; icon = row.icon
        self.reference = reference
    }
    /// The row as the composer picks it, from the + list's path (no word to replace).
    var row: SuggestionRow {
        SuggestionRow(id: id, group: "", label: label, detail: detail, icon: icon, pick: "reference", notice: nil,
                      action: nil, parameters: [], reference: reference)
    }
    /// How many a project keeps.
    static let kept = 3
}

extension NewThreadMemory {
    /// The picks the last thread in `draft`'s project started with, on its machine.
    func picks(for draft: NewThreadDraft) -> NewThreadPicks? {
        guard let machine = draft.machineId, let project = draft.projectId else { return nil }
        return projects?[NewThreadPicks.key(machine: machine, project: project)]
    }
    /// `draft` moved to another project: that project's last picks come back; a project with none
    /// keeps what the draft had.
    func chose(project: String, in draft: NewThreadDraft) -> NewThreadDraft {
        var next = draft
        next.projectId = project
        next.base = nil
        guard let picks = picks(for: next) else {
            if next.isChat { next.worktree = false }
            return next
        }
        return picks.applied(to: next)
    }
    /// A thread started from `draft`: its picks become its project's.
    mutating func started(_ draft: NewThreadDraft) {
        record(draft)
        guard let machine = draft.machineId, let project = draft.projectId else { return }
        var all = projects ?? [:]
        all[NewThreadPicks.key(machine: machine, project: project)] = NewThreadPicks(draft)
        projects = all
    }
    func skills(for draft: NewThreadDraft) -> [NewThreadSkill] {
        guard let machine = draft.machineId, let project = draft.projectId else { return [] }
        return skills?[NewThreadPicks.key(machine: machine, project: project)] ?? []
    }
    /// `skill` was picked in `draft`'s project: it leads that project's list.
    mutating func used(_ skill: NewThreadSkill, in draft: NewThreadDraft) {
        guard let machine = draft.machineId, let project = draft.projectId else { return }
        let key = NewThreadPicks.key(machine: machine, project: project)
        var all = skills ?? [:]
        all[key] = Array(([skill] + (all[key] ?? []).filter { $0.id != skill.id }).prefix(NewThreadSkill.kept))
        skills = all
    }
}

extension NewThreadMemoryStore {
    func started(_ draft: NewThreadDraft) {
        update { memory in
            memory.machine = draft.machineId ?? memory.machine
            memory.started(draft)
        }
    }
    func used(_ skill: NewThreadSkill, in draft: NewThreadDraft) { update { $0.used(skill, in: draft) } }
}
