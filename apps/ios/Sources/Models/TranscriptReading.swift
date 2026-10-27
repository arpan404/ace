import Foundation
import Observation
import QuartzCore

private struct TranscriptReadingReply: Decodable {
    let active: Bool
    let hasOlder: Bool
    let hasNewer: Bool
    let joined: Bool
    let focus: String?
    let count: Int
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
    /// The item a jump aimed at, until the feed has scrolled to it.
    var focus: String?
    @ObservationIgnored private var request: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var retryOperation = "older"
    @ObservationIgnored private var retryItem: String?
    @ObservationIgnored private var retryTurn: Int?
    /// Each reading view's epoch, below every navigation epoch; never reused in a run.
    @ObservationIgnored private static var epochs = 0

    func read(_ operation: String, model: ClientModel, live: ThreadModel, item: String? = nil, turn: Int? = nil) {
        guard !loading else { return }
        loading = true
        problem = nil
        retryOperation = operation
        retryItem = item
        retryTurn = turn
        self.operation = operation
        let version = generation
        let asked = CACurrentMediaTime()
        // Going live only ends the window; every other read shows rows under this view's epoch.
        let epoch = operation == "live" ? (thread?.epoch ?? -1) : (thread ?? open(model: model, live: live)).epoch
        var payload: [String: Any] = ["type": "native.transcript", "threadId": live.id, "epoch": epoch, "operation": operation]
        if let item { payload["itemId"] = item }
        if let turn { payload["ordinal"] = turn }
        // A page's rows land together once the bridge says the read settled.
        if operation != "live" { model.holdReading() }
        request = Task {
            defer { if generation == version { loading = false } }
            do {
                let reply = try await model.service(payload, as: TranscriptReadingReply.self)
                guard !Task.isCancelled, generation == version else { return }
                guard reply.active else { close(model: model); revision += 1; return }
                hasOlder = reply.hasOlder
                hasNewer = reply.hasNewer
                joined = reply.joined
                if let target = reply.focus { focus = target }
                if operation != "hold" { paged = true }
                ThreadOpenTrace.page(operation, items: reply.count, blocks: thread?.screen.blockOrder.count ?? 0, seconds: CACurrentMediaTime() - asked)
            } catch {
                guard !Task.isCancelled, generation == version else { return }
                model.releaseReading()
                problem = error.localizedDescription
            }
        }
    }
    func retry(model: ClientModel, live: ThreadModel) { read(retryOperation, model: model, live: live, item: retryItem, turn: retryTurn) }
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
    }
}
