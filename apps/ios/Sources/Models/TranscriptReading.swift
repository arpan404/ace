import Foundation
import Observation
import QuartzCore

/// Freshness of the history window's rows, from the bridge service reply.
/// `.current` rows came from the authoritative window; `.cached` rows came
/// from the stale-only disk cache and are read-only until a fresh complete
/// window replaces them. Absent (older bridges) decodes as `.current`.
enum TranscriptFreshness: String, Decodable, Sendable {
    case current
    case cached
}

struct TranscriptReadingReply: Decodable {
    let active: Bool
    let hasOlder: Bool
    let hasNewer: Bool
    let joined: Bool
    let focus: String?
    let count: Int
    let freshness: TranscriptFreshness?
    /// Explicit window change evidence (all block IDs, optional for compat):
    /// rows evicted to each side (still canonical), rows authoritatively
    /// deleted/regrouped (never spacers), and the window's exclusive sequence
    /// cursors plus distant retained counts grounding folded totals.
    let evictedLeading: [String]?
    let evictedTrailing: [String]?
    let deleted: [String]?
    let beforeSeq: Int?
    let afterSeq: Int?
    let beforeCount: Int?
    let afterCount: Int?
    /// Creation-sequence spans of the reply's resident blocks, keyed by raw
    /// block ID. Grounds distant segments and rehydration.
    let blockSeqs: [String: BlockSeqSpan]?
}

/// The last window change the bridge reported, grounding the next explicit
/// extent update.
struct ReadingWindowMetadata: Equatable, Sendable {
    var evictedLeading: [String]?
    var evictedTrailing: [String]?
    var deleted: [String]?
    var beforeSeq: Int?
    var afterSeq: Int?
    var beforeCount: Int?
    var afterCount: Int?
    /// Sequence spans of the reply's resident blocks, keyed by raw block ID.
    var blockSeqs: [String: BlockSeqSpan]?
    static let empty = Self()

    /// Whether this reply carried fresh per-read eviction evidence. Only the
    /// first extent update after the reply may retain space from these lists;
    /// afterwards they are consumed so a previous eviction list can never mask
    /// a later canonical delete.
    var hasFreshLists: Bool {
        evictedLeading != nil || evictedTrailing != nil || deleted != nil
    }

    var hasEvidence: Bool {
        hasFreshLists || beforeSeq != nil || afterSeq != nil
            || beforeCount != nil || afterCount != nil
    }
}

/// An item a search hit asked to bring into view in its thread.
struct ThreadFocus: Equatable {
    let thread: String
    let item: String
    /// A turn from the turn list instead of an item: its ask comes into view.
    var turn: Int? = nil
}

/// The phone's side of the shared history window (`bridge/native-transcript.ts`). The bridge
/// slides, evicts and joins the window; its rows arrive as patches under this view's own
/// negative epoch into `thread`, so a page brings only the rows it added or evicted, and a window
/// joined to the live tail keeps streaming. The live thread stays subscribed beside it.
@MainActor @Observable final class TranscriptReading {
    private(set) var thread: ThreadModel?
    /// The reading rows once the first of them has landed; until then the live rows stay shown.
    var shown: ThreadModel? { thread.flatMap { $0.order.isEmpty ? nil : $0 } }
    private(set) var hasOlder = true
    private(set) var hasNewer = false
    private(set) var joined = true
    private(set) var loading = false
    private(set) var problem: String?
    /// Moves after each frame that moved the reading rows.
    private(set) var revision = 0
    private(set) var paged = false
    private(set) var operation = ""
    /// The window's rows are stale disk cache (or were read while offline):
    /// shown read-only with a cached/retry indication until a fresh complete
    /// window replaces them. Preserved across loads; only a `.current` reply
    /// for the current generation clears it.
    private(set) var isStale = false
    /// Explicit change evidence from the last reply, grounding the feed's next
    /// extent update. Reset when the window closes.
    private(set) var lastWindow = ReadingWindowMetadata.empty
    /// The item a jump aimed at, until the feed has scrolled to it.
    var focus: String?
    @ObservationIgnored private var request: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var retryOperation = "older"
    @ObservationIgnored private var retryItem: String?
    @ObservationIgnored private var retryTurn: Int?
    @ObservationIgnored private var retryAnchorItemId: String?
    /// Each reading view's epoch, below every navigation epoch; never reused in a run.
    @ObservationIgnored private static var epochs = 0

    func read(_ operation: String, model: ClientModel, live: ThreadModel, item: String? = nil, turn: Int? = nil, anchorItemId: String? = nil) {
        guard !loading else { return }
        retryOperation = operation
        retryItem = item
        retryTurn = turn
        retryAnchorItemId = anchorItemId
        perform(operation, model: model, live: live, item: item, turn: turn, anchorItemId: anchorItemId, updateRetry: false)
    }

    /// Re-ask the bridge for the same window without moving it, keeping the
    /// reader's semantic anchor so the rebuild loads around it. Used after a
    /// reconnect: the bridge resets its stale window and loads around
    /// `anchorItemId` before answering `.current`; `isStale` stays set until
    /// that fresh complete window lands.
    func refreshAfterReconnect(model: ClientModel, live: ThreadModel, anchorItemId: String? = nil) {
        guard !loading, thread != nil else { return }
        perform("hold", model: model, live: live, item: nil, turn: nil, anchorItemId: anchorItemId ?? retryAnchorItemId, updateRetry: false)
    }

    /// Rebuild the authoritative window around the anchor item after the held
    /// queue overflowed (or the bridge marked the window stale). Keeps the
    /// existing rows on screen until the replacement lands: no cancel, no
    /// close, same view epoch. The bridge answers with a fresh reset and the
    /// hold clears `needsFresh` only when those complete rows flush.
    func rebuild(model: ClientModel, live: ThreadModel, anchorItemId: String) {
        guard !loading, thread != nil else { return }
        perform("item", model: model, live: live, item: anchorItemId, turn: nil, anchorItemId: anchorItemId, updateRetry: true)
    }

    /// The last anchor item a read carried: recovery fuel when no frame is
    /// measured yet. Production accessor for the needs-fresh hook.
    var lastAnchorItemId: String? { retryAnchorItemId }

    /// Synchronous freshness bookkeeping, testable without the bridge.
    func applyFreshness(_ freshness: TranscriptFreshness?) {
        isStale = (freshness ?? .current) == .cached
    }

    /// Whether the last reply's eviction lists are still unconsumed. Only the
    /// first extent update after a reply may use them.
    var hasFreshWindowEvidence: Bool { lastWindow.hasFreshLists }

    /// Take the last reply's window evidence for one explicit extent update,
    /// consuming the per-read eviction lists so they cannot mask a later
    /// canonical delete. Cursors, counts and spans persist until the next
    /// reply refreshes them.
    func takeWindowEvidence() -> ReadingWindowMetadata {
        let evidence = lastWindow
        lastWindow.evictedLeading = nil
        lastWindow.evictedTrailing = nil
        lastWindow.deleted = nil
        return evidence
    }

    /// Fold a service reply into window state. The production path called by
    /// every read's task; directly testable without the bridge by decoding a
    /// reply and applying it here.
    func applyReply(_ reply: TranscriptReadingReply, operation: String) {
        hasOlder = reply.hasOlder
        hasNewer = reply.hasNewer
        joined = reply.joined
        if let target = reply.focus { focus = target }
        if operation != "hold", operation != "follow" { paged = true }
        lastWindow = ReadingWindowMetadata(
            evictedLeading: reply.evictedLeading,
            evictedTrailing: reply.evictedTrailing,
            deleted: reply.deleted,
            beforeSeq: reply.beforeSeq,
            afterSeq: reply.afterSeq,
            beforeCount: reply.beforeCount,
            afterCount: reply.afterCount,
            blockSeqs: reply.blockSeqs)
        // Only a fresh complete window for this generation clears stale:
        // a cached reply (or an offline read) keeps it set.
        applyFreshness(reply.freshness)
    }

    private func perform(_ operation: String, model: ClientModel, live: ThreadModel, item: String?, turn: Int?, anchorItemId: String?, updateRetry: Bool) {
        // Serialized like read(): one in-flight request at a time, and the
        // replaced handle is cancelled so a stale task can never publish over
        // the new one.
        guard !loading else { return }
        loading = true
        problem = nil
        request?.cancel()
        request = nil
        if updateRetry {
            retryOperation = operation
            retryItem = item
            retryTurn = turn
            retryAnchorItemId = anchorItemId
        }
        self.operation = operation
        let version = generation
        let asked = CACurrentMediaTime()
        // Going live only ends the window; every other read shows rows under this view's epoch.
        let epoch = operation == "live" ? (thread?.epoch ?? -1) : (thread ?? open(model: model, live: live)).epoch
        var payload: [String: Any] = ["type": "native.transcript", "threadId": live.id, "epoch": epoch, "operation": operation]
        if let item { payload["itemId"] = item }
        if let turn { payload["ordinal"] = turn }
        if let anchorItemId { payload["anchorItemId"] = anchorItemId }
        // A page's rows land together once the bridge says the read settled.
        if operation != "live" { model.holdReading() }
        request = Task {
            defer { if generation == version { loading = false } }
            do {
                let reply = try await model.service(payload, as: TranscriptReadingReply.self)
                guard !Task.isCancelled, generation == version else { return }
                guard reply.active else { close(model: model); isStale = false; revision += 1; return }
                applyReply(reply, operation: operation)
                ThreadOpenTrace.page(operation, items: reply.count, blocks: thread?.screen.blockOrder.count ?? 0, seconds: CACurrentMediaTime() - asked)
            } catch {
                guard !Task.isCancelled, generation == version else { return }
                model.releaseReading()
                problem = error.localizedDescription
            }
        }
    }
    func retry(model: ClientModel, live: ThreadModel) { read(retryOperation, model: model, live: live, item: retryItem, turn: retryTurn, anchorItemId: retryAnchorItemId) }
    func live(model: ClientModel, thread: ThreadModel) {
        cancel(model: model)
        read("live", model: model, live: thread)
    }
    /// Open a window around `item` (a search hit) and bring it into view.
    func jump(to item: String, model: ClientModel, live: ThreadModel) {
        cancel(model: model)
        read("item", model: model, live: live, item: item)
    }
    /// Open a window at turn `ordinal` (the turn list) and bring its ask into view.
    func jump(toTurn ordinal: Int, model: ClientModel, live: ThreadModel) {
        cancel(model: model)
        read("turn", model: model, live: live, turn: ordinal)
    }
    func cancel(model: ClientModel) {
        generation += 1
        request?.cancel(); request = nil
        loading = false; problem = nil; focus = nil
        close(model: model)
        paged = false; hasOlder = true; hasNewer = false; joined = true
        isStale = false
        lastWindow = .empty
        retryAnchorItemId = nil
    }
    /// The reading rows moved: the feed restores the reader's place against them.
    func moved() { revision += 1 }

    private func open(model: ClientModel, live: ThreadModel) -> ThreadModel {
        Self.epochs += 1
        let next = ThreadModel(id: live.id)
        next.epoch = -Self.epochs
        next.disclosures = live.disclosures
        next.metadata = live.metadata
        next.loaded = true
        model.reading = next
        thread = next
        return next
    }
    private func close(model: ClientModel) {
        if model.reading === thread { model.dropReading() }
        thread = nil
        lastWindow = .empty
    }
}
