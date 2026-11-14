import Foundation
import Observation

struct ConversationHit: Decodable, Identifiable, Sendable {
    struct Snippet: Decodable, Sendable { let text: String }
    let threadId: String
    let threadTitle: String
    let itemId: String?
    let kind: String
    let provider: String
    let createdAt: Double
    let title: Snippet
    let snippet: Snippet
    /// The daemon's relevance, for merging several machines' hits; nil from older daemons.
    var score: Double? = nil
    var workspaceId: String? = nil
    var id: String { "\(threadId):\(itemId ?? "title"):\(kind)" }
    var excerpt: String { kind == "thread" ? title.text : snippet.text }
    /// A hit within one thread leads with what matched, as the thread's own title would repeat
    /// on every row: its kind, and a tool's or visualization's title when it has one.
    var inThreadLead: String {
        let label = switch kind {
        case "thread": "Thread title"
        case "message": "Message"
        case "reasoning": "Reasoning"
        case "tool_call": "Tool"
        case "notice": "Notice"
        case "compaction": "Compaction"
        case "delegation.started": "Subagent started"
        case "delegation.settled": "Subagent finished"
        case "artifact": "File"
        case "html": "Visualization"
        default: kind.replacingOccurrences(of: "_", with: " ").capitalized
        }
        let named = kind == "thread" ? "" : title.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return named.isEmpty ? label : "\(label) · \(named)"
    }
}
struct ConversationSearchReply: Decodable {
    let type: String
    let hits: [ConversationHit]?
    let cursor: String?
    let code: String?
}

/// One machine and query at a time. Late replies cannot replace a newer query or append its pages.
@MainActor @Observable final class ConversationSearch {
    private(set) var hits: [ConversationHit] = []
    private(set) var cursor: String?
    private(set) var loading = false
    private(set) var loaded = false
    private(set) var problem: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var filters: [String: Any] = [:]

    /// `filters` adds the search's own filters (`workspaceId`, `after`). The previous query's
    /// hits stay on screen until this one's arrive, so results never blank between keystrokes.
    func search(model: ClientModel, text: String, kind: String, threadId: String?, filters: [String: Any] = [:]) async {
        generation += 1
        let current = generation
        cursor = nil; problem = nil; loaded = false
        self.filters = filters
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { hits = []; loading = false; return }
        guard model.connection == "ready" else {
            hits = []; loading = false; problem = model.problem?.message ?? "Machine offline. Reconnect to search its conversations."
            return
        }
        loading = true
        do {
            try await Task.sleep(for: .milliseconds(250))
            let reply = try await read(model, text: query, kind: kind, threadId: threadId, cursor: nil)
            guard current == generation, !Task.isCancelled else { return }
            hits = reply.hits ?? []; cursor = reply.cursor; loaded = true; loading = false
        } catch {
            guard current == generation else { return }
            loading = false
            if !Task.isCancelled { hits = []; problem = error.localizedDescription }
        }
    }
    func more(model: ClientModel, text: String, kind: String, threadId: String?) async {
        guard let cursor, !loading else { return }
        let current = generation
        loading = true; problem = nil
        defer { if current == generation { loading = false } }
        do {
            let reply = try await read(model, text: text, kind: kind, threadId: threadId, cursor: cursor)
            guard current == generation, !Task.isCancelled else { return }
            let known = Set(hits.map(\.id))
            hits += (reply.hits ?? []).filter { !known.contains($0.id) }
            self.cursor = reply.cursor
        } catch { if current == generation && !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func read(_ model: ClientModel, text: String, kind: String, threadId: String?, cursor: String?) async throws -> ConversationSearchReply {
        var filters = self.filters
        if !kind.isEmpty { filters["kind"] = kind }
        if let threadId { filters["threadId"] = threadId }
        var request: [String: Any] = ["type": "search.query", "text": text, "limit": 50, "filters": filters]
        if let cursor { request["cursor"] = cursor }
        let reply = try await model.service(request, as: ConversationSearchReply.self)
        guard reply.type == "search.results" else {
            // A stale cursor can't fetch another page: drop it, so Try again searches afresh.
            if reply.code == "search_cursor_stale" { self.cursor = nil }
            let message = switch reply.code {
            case "search_cursor_stale": "The search index changed. Search again to refresh the results."
            case "search_invalid_query": "That search couldn't run. Try fewer or simpler words."
            default: "Search couldn't finish. Check the connection and retry."
            }
            throw ServiceFailure(message: message)
        }
        return reply
    }
}
