import Foundation
import SwiftUI

/// The bridge's Automations answers (`bridge/automations.ts`, `bridge/automation-form.ts`): rows
/// and turns already worded by `@ace/ui-core/automations`. Swift draws them and sends intents; it
/// never words a schedule, checks a field or decides a run's state.

/// A loud or quiet word before a row or a run: "Failed", "Needs you", "Paused".
struct AutomationHead: Codable, Sendable, Equatable {
    let tone: String
    let word: String
    var status: StatusDisplay { StatusDisplay(label: word, token: tone == "needs-you" ? "needsYou" : tone) }
}

struct AutomationListRow: Decodable, Sendable, Identifiable, Equatable {
    struct Attention: Decodable, Sendable, Equatable { let word: String; let text: String; let at: Double; let retry: Bool }
    struct LastRun: Decodable, Sendable, Equatable { let status: String; let text: String }
    let id: String
    let title: String
    let enabled: Bool
    /// "person", or "thread" for one an agent made from a thread.
    let source: String
    /// The thread an agent made it from.
    let owner: String?
    let revision: Int?
    /// The stored definition, sent back unchanged for Edit and Duplicate.
    let automation: ServiceValue
    let status: AutomationHead?
    /// "Tonight 2:00 AM · Every day", "On pull requests".
    let detail: String
    /// "Every day at 9:00 AM", "When an issue is labelled (bug) in owner/name".
    let when: String
    /// "Tomorrow 9:00 AM · in 21h", "Paused. Resume to schedule the next run."
    let next: String
    let attention: Attention?
    let lastRun: LastRun?
    let project: String
    let agent: String
    let model: String?
    let kind: String
    static func == (a: Self, b: Self) -> Bool {
        a.id == b.id && a.title == b.title && a.enabled == b.enabled && a.revision == b.revision && a.status == b.status
            && a.detail == b.detail && a.when == b.when && a.next == b.next && a.attention == b.attention
            && a.lastRun == b.lastRun && a.project == b.project && a.agent == b.agent && a.model == b.model
    }
}

struct AutomationPage: Decodable, Sendable {
    /// Automations are off on the machine: what to say and where to turn them on.
    struct Off: Decodable, Sendable { let text: String; let fix: String }
    let off: Off?
    let ok: Bool
    let error: String?
    let unavailable: Bool?
    let person: [AutomationListRow]?
    let threads: [AutomationListRow]?
    /// How soon to read again: sooner while a run goes.
    let pollMs: Int?
}

struct AutomationRunRow: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let status: String
    let threadId: String?
    let startedAt: Double
    let finishedAt: Double?
    /// "Today 2:00 PM".
    let when: String
    let head: AutomationHead?
    /// "Worked for 14m", "after 2m".
    let detail: String?
    let note: String?
    /// Still going: "Working for" counts up beside it.
    let live: Bool
    let body: String?
    let muted: Bool
    let runAgain: Bool
}

struct AutomationHistory: Decodable, Sendable {
    let ok: Bool
    let error: String?
    let runs: [AutomationRunRow]?
    let before: Int?
    let pollMs: Int?
}

/// The web's `AutomationForm`, field for field. The bridge fills, checks and saves it.
struct AutomationFormValues: Codable, Sendable, Equatable {
    var title: String
    var prompt: String
    var workspace: String
    var provider: String
    var access: String?
    var model: String
    var effort: String?
    var instance: String?
    var trigger: String
    var cadence: String
    var time: String
    var day: String
    var every: Int
    var minutes: Int
    var date: String
    var startsAt: String
    var timezone: String
    var startAt: Double?
    var syntax: String
    var expression: String
    var repository: String
    var event: String
    var label: String
    var paths: String
    var worktree: Bool
    var missedRun: String
    var json: [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }
}

/// What the shared model picker holds: the option key, its account and the effort.
struct AutomationPick: Codable, Sendable, Equatable {
    var provider: String
    var key: String
    var account: String?
    var effort: String?
    var json: [String: Any] {
        var out: [String: Any] = ["provider": provider, "key": key]
        if let account { out["account"] = account }
        if let effort { out["effort"] = effort }
        return out
    }
}

struct AutomationChoice: Decodable, Sendable, Hashable, Identifiable {
    let value: String
    let label: String
    var id: String { value }
}

/// The form as the bridge last described it: the summary, problems and next starts.
struct AutomationFormView: Decodable, Sendable {
    struct Instants: Decodable, Sendable { let at: Double; let time: Double; let startsAt: Double? }
    struct Choices: Decodable, Sendable {
        let triggers: [AutomationChoice]
        let cadences: [AutomationChoice]
        let weekdays: [AutomationChoice]
        let syntaxes: [AutomationChoice]
        let events: [AutomationChoice]
        let missed: [AutomationChoice]
    }
    let ok: Bool
    let error: String?
    let form: AutomationFormValues?
    let summary: String?
    let errors: [String: String]?
    let problem: String?
    let upcoming: [String]?
    let line: String?
    let instants: Instants?
    let today: Double?
    let hours: [AutomationChoice]?
    let minutes: [AutomationChoice]?
    let pick: AutomationPick?
    let choices: Choices?
}

/// A save, run or duplicate the bridge answered.
struct AutomationWrite: Decodable, Sendable {
    let ok: Bool
    let error: String?
    let id: String?
    /// Why a run asked for didn't start yet ("Waiting for the last run to finish").
    let note: String?
}

extension ServiceValue {
    /// As `JSONSerialization` takes it, to send back to the bridge.
    var any: Any {
        switch self {
        case .string(let value): value
        case .number(let value): value
        case .bool(let value): value
        case .null: NSNull()
        case .array(let values): values.map(\.any)
        case .object(let values): values.mapValues(\.any)
        }
    }
}

/// How the Automations screens move inside Settings' stack: open an automation, show another in
/// its place (the copy Duplicate made), and open a run's thread.
struct AutomationLinks: ViewModifier {
    let open: (String) -> Void
    let replace: (String) -> Void
    let thread: (String) -> Void
    /// The automation just deleted, for the list's Undo.
    let undo: AutomationUndo
    func body(content: Content) -> some View {
        content.environment(\.automationLinks, self)
    }
}

/// The last automation deleted on this machine's Settings stack: the list offers Undo for it.
@MainActor @Observable final class AutomationUndo {
    struct Deleted: Equatable {
        let id = UUID()
        let title: String
        /// The definition as it was, sent back to make it again.
        let automation: ServiceValue
        static func == (a: Deleted, b: Deleted) -> Bool { a.id == b.id }
    }
    var deleted: Deleted?
}

extension EnvironmentValues {
    @Entry var automationLinks: AutomationLinks? = nil
}
