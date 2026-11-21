import Foundation
import os

/// Debug builds only: what reached Spade's open conversation, patch by patch, and what its
/// transcript laid out, to tell a chat that got no rows from one whose rows draw nothing. Read it
/// off a phone with `log collect --device --last 10m` and the predicate
/// `subsystem == "app.ace.ios" && category == "spade-feed"`. Words are never logged, only counts,
/// kinds and sizes.
@MainActor enum SpadeFeedTrace {
    #if DEBUG
    nonisolated private static let log = Logger(subsystem: "app.ace.ios", category: "spade-feed")
    #endif

    /// One patch applied: its type, the conversation it named and what the model holds after it.
    static func applied(_ patch: SpadeModel.Patch, model: SpadeModel) {
        #if DEBUG
        let what: String
        switch patch {
        case .state(let state): what = "state rows=\(state.list.rows?.count ?? -1)"
        case .conversation(let head):
            what = head.map { "head id=\(short($0.id)) loaded=\($0.loaded) working=\($0.working != nil) problem=\($0.problem != nil)" } ?? "head closed"
        case .order(let id, let keys): what = "order id=\(short(id)) keys=\(keys.count)"
        case .row(let id, let key, let bubble): what = "row id=\(short(id)) key=\(key.count)ch kind=\(kind(bubble))"
        }
        let order = model.order
        let missing = order.filter { model.bubbles[$0] == nil }.count
        let kinds = Dictionary(grouping: order.compactMap { model.bubbles[$0].map(kind) }, by: \.self)
            .map { "\($0.key)=\($0.value.count)" }.sorted().joined(separator: ",")
        let holds = "holds head=\(model.conversation.map { short($0.id) } ?? "nil") loaded=\(model.conversation?.loaded ?? false) "
            + "order=\(order.count) missing=\(missing) [\(kinds)]"
        log.notice("\(what, privacy: .public) | \(holds, privacy: .public)")
        #endif
    }

    /// The transcript's laid-out height changed: rows that draw nothing show here as a height
    /// near zero while `order` holds rows.
    static func laidOut(contentHeight: Double, viewport: Double, rows: Int) {
        #if DEBUG
        log.notice("layout content=\(Int(contentHeight), privacy: .public) viewport=\(Int(viewport), privacy: .public) rows=\(rows, privacy: .public)")
        #endif
    }

    private static func short(_ id: String) -> String { String(id.suffix(6)) }

    private static func kind(_ bubble: SpadeModel.Bubble) -> String {
        switch bubble {
        case .person: "person"
        case .bot(let text, _, let end): text.isEmpty ? (end == nil ? "bot-empty" : "bot-end") : "bot"
        case .ask: "ask"
        case .question(let card): "question-\(card.standing.rawValue)"
        case .member: "member"
        case .note: "note"
        }
    }
}
