import Foundation

/// One choice in a Snooze menu: a time preset from the layout, or an event the thread's row
/// offers. `id` is the inbox action's preset ("hour", "needs_you", "pr").
struct SnoozeChoice: Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    /// What brings it back, under an event's label; nil for a time.
    let detail: String?

    /// The menu's order, as web lists it: "Until it needs you" leads, the times follow, and
    /// "Until the PR changes" closes. A row from an older bridge offers only the times.
    static func list(times: [InboxLayout.SnoozeOption], row: ThreadRow?) -> [SnoozeChoice] {
        let events = row?.snoozeEvents ?? []
        let event = { (id: String) in events.filter { $0.id == id }.map { SnoozeChoice(id: $0.id, label: $0.label, detail: $0.detail) } }
        return event("needs_you") + times.map { SnoozeChoice(id: $0.id, label: $0.label, detail: nil) } + event("pr")
    }
}
