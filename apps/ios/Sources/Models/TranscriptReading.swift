import Foundation
import Observation

private struct TranscriptReadingReply: Decodable {
    struct Block: Decodable { let id: String; let row: BlockRow }
    let active: Bool
    let hasOlder: Bool
    let hasNewer: Bool
    let joined: Bool
    let items: [TranscriptRow]
    let blocks: [Block]
}

/// Native presentation of the shared bounded reading window. The live model stays subscribed.
@MainActor @Observable final class TranscriptReading {
    private(set) var thread: ThreadModel?
    private(set) var hasOlder = true
    private(set) var hasNewer = false
    private(set) var joined = true
    private(set) var loading = false
    private(set) var problem: String?
    private(set) var revision = 0
    private(set) var paged = false
    private(set) var operation = ""
    @ObservationIgnored var willReplace: (() -> Void)?
    @ObservationIgnored private var request: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var retryOperation = "older"

    func read(_ operation: String, model: ClientModel, live: ThreadModel) {
        guard !loading else { return }
        loading = true
        problem = nil
        retryOperation = operation
        self.operation = operation
        let version = generation
        request = Task {
            defer { if generation == version { loading = false } }
            do {
                let reply = try await model.service(["type": "native.transcript", "threadId": live.id, "operation": operation], as: TranscriptReadingReply.self)
                guard !Task.isCancelled, generation == version else { return }
                guard reply.active else { thread = nil; revision += 1; return }
                let next = ThreadModel(id: live.id)
                next.epoch = live.epoch
                next.metadata = live.metadata
                next.interactions = live.interactions
                for row in reply.items {
                    let item = thread?.items[row.id] ?? ItemModel(row)
                    item.row = row
                    next.items[row.id] = item
                    next.order.append(row.id)
                }
                for block in reply.blocks { next.screen.apply(.block(live.id, live.epoch, block.id, block.row)) }
                next.screen.commit()
                next.loaded = true
                hasOlder = reply.hasOlder
                hasNewer = reply.hasNewer
                joined = reply.joined
                willReplace?()
                thread = next
                if operation == "older" || operation == "newer" { paged = true }
                revision += 1
            } catch {
                if !Task.isCancelled, generation == version { problem = error.localizedDescription }
            }
        }
    }
    func retry(model: ClientModel, live: ThreadModel) { read(retryOperation, model: model, live: live) }
    func live(model: ClientModel, thread: ThreadModel) {
        cancel()
        read("live", model: model, live: thread)
    }
    func cancel() {
        generation += 1
        request?.cancel(); request = nil
        loading = false; problem = nil
        thread = nil; paged = false; hasOlder = true; hasNewer = false; joined = true
    }
}
