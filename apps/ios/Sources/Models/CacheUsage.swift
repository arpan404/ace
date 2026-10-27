import Foundation

/// `cache.usage` (`bridge/chat-cache.ts`): how many threads the phone keeps for one machine and
/// how many bytes their store takes on disk.
struct CacheUsage: Codable, Sendable, Equatable {
    let threads: Int
    let bytes: Int
}
