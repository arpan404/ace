import ActivityKit
import Foundation

struct ThreadActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let title: String
        let label: String
        let token: String
        let online: Bool
        /// Whether the row is the daemon's current list. Nil decodes old activities, which read
        /// as unconfirmed and never as done.
        var confirmed: Bool? = nil
        let updatedAt: Date
    }
    let hostId: String
    let threadId: String
}
