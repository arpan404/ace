import Foundation

/// The thread's Logs as the bridge shapes them (`bridge/logs.ts`, the shared `threadLog`): the
/// newest page of lines for the scope and filter, how many are earlier, and the scope's choices.
struct LogsSheet: Codable, Sendable, Equatable {
    struct Line: Codable, Sendable, Equatable, Identifiable {
        let key: String
        let at: Double
        let source: String
        let sourceLabel: String
        /// info, warn or error.
        let level: String
        let text: String
        var id: String { key }
    }
    struct Query: Codable, Sendable, Equatable {
        var agentId: String?
        var level: String
        var hidden: [String]
        var query: String
        static let all = Query(agentId: nil, level: "all", hidden: [], query: "")
        var json: [String: Any] { ["agentId": agentId ?? NSNull(), "level": level, "hidden": hidden, "query": query] }
    }
    struct Source: Codable, Sendable, Equatable, Identifiable { let id: String; let label: String }
    struct Agent: Codable, Sendable, Equatable, Identifiable { let id: String; let name: String; let parentId: String? }
    let scope: Query
    let scopeName: String?
    let lines: [Line]
    /// Matching lines before the first one shown.
    let earlier: Int
    /// Lines matching the scope and filter, and lines in the whole log.
    let total: Int
    let all: Int
    let sources: [Source]
    let agents: [Agent]
}
