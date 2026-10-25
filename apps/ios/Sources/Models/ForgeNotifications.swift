import Foundation

/// The person's GitHub notifications (`bridge/forge-inbox.ts`).
struct ForgeNotifications: Decodable, Sendable, Equatable {
    struct Opens: Decodable, Sendable, Equatable, Hashable { let kind: String; let number: Int; let repository: ForgeRepository? }
    struct Row: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let title: String
        let repository: String
        let number: Int?
        let type: String
        /// `pull` or `issue`; nil for other subjects.
        let glyph: String?
        let state: ForgeMark?
        let merged: Bool
        let reason: String
        let unread: Bool
        let updatedAt: Double?
        let opens: Opens?
        let url: String
    }
    struct Reason: Decodable, Sendable, Equatable, Hashable { let value: String; let label: String }
    let rows: [Row]
    let more: Bool
    let reasons: [Reason]
}

/// What the inbox asks GitHub for: unread or all, only participating, one reason.
struct NotificationsFilter: Equatable, Hashable, Sendable {
    var all = false
    var participating = false
    var reason: String?
}

extension ClientModel {
    static func forgeNotificationsRead(project: String, filter: NotificationsFilter, screens: Int = 1) -> [String: Any] {
        var read: [String: Any] = ["type": "forge.inbox", "project": project, "all": filter.all, "participating": filter.participating, "screens": screens]
        if let reason = filter.reason { read["reason"] = reason }
        return read
    }
    func forgeNotifications(project: String, filter: NotificationsFilter, screens: Int) async throws -> ForgeNotifications {
        try await read(Self.forgeNotificationsRead(project: project, filter: filter, screens: screens), as: ForgeNotifications.self)
    }
    /// Mark one notification read or done, or unsubscribe from it. Sent once; only the person
    /// sends it again.
    func forgeNotificationWrite(project: String, action: String, id: String) async -> ForgeReviewOutcome {
        guard canOperate else { return ForgeReviewOutcome(ok: false, message: "View only. Pair this phone with View and act to change notifications.", uncertain: false) }
        do { return try await service(["type": "forge.inbox.write", "project": project, "action": action, "id": id], as: ForgeReviewOutcome.self) }
        catch { return ForgeReviewOutcome(ok: false, message: error.localizedDescription, uncertain: false) }
    }
}
