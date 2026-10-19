import ActivityKit
import Foundation

struct ThreadActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let title: String
        let label: String
        let token: String
        let online: Bool
        let updatedAt: Date
    }
    let hostId: String
    let threadId: String
}
