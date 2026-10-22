import Foundation
import Observation

@MainActor @Observable final class BlockModel: Identifiable {
    let id: String
    var row: BlockRow { didSet { if row.room != room { room = row.room } } }
    /// Observed apart from `row`, so the feed's spacing never re-reads on a block's live update.
    private(set) var room: BlockRow.Room?
    init(id: String, row: BlockRow) { self.id = id; self.row = row; self.room = row.room }
}

/// The open thread's blocks, composer controls, history paging and model list. Block identity
/// survives updates, and order changes only when membership or positions do.
@MainActor @Observable final class ThreadScreenModel {
    var blocks: [String: BlockModel] = [:]
    var blockOrder: [String] = []
    var controls: ControlsRow?
    var hasOlder = false
    var loadingOlder = false
    var modelsState = "idle"
    var models: [ModelOption] = []
    /// Follow-ups waiting in the daemon's queue, outside the transcript until delivered.
    var queue: QueueRow?
    /// Stop was pressed; cleared when the tree stops working, or when this Stop's own request
    /// fails to save or is refused while the tree keeps working.
    var stopping = false
    /// The local request id of the Stop in flight, so a late result of an older one is ignored.
    @ObservationIgnored var stopRequest: String?
    /// Finished turns' steps read on demand, by turn ordinal.
    var steps: [Int: TurnStepsModel] = [:]
    /// The thread's live line and the strip's words while it only waits; nil when nothing is live.
    var activity: ActivityRow?
    /// Subagent groups the person opened, by block id. Kept across a reload of the thread, so
    /// coming back from a child finds the group as it was left.
    var openGroups: Set<String> = []
    /// Effort and speed for the next message.
    var tune: TuneRow?
    /// Files on the next message and their uploads.
    var attachments: [AttachmentFile] = []
    /// The native subagent lane open in its sheet.
    var lane: LaneModel?
    @ObservationIgnored private var positions: [String: Int] = [:]
    @ObservationIgnored private var reorder = false

    func reset() {
        blocks.removeAll(keepingCapacity: true)
        positions.removeAll(keepingCapacity: true)
        blockOrder = []
        controls = nil
        queue = nil
        activity = nil
        steps = [:]
        tune = nil
        attachments = []
        hasOlder = false
        loadingOlder = false
    }
    /// Applies one thread-screen patch already scoped to this thread's navigation generation.
    func apply(_ patch: BridgePatch) {
        switch patch {
        case .block(_, _, let id, let row):
            if let row {
                if let block = blocks[id] { if block.row != row { block.row = row } }
                else { blocks[id] = BlockModel(id: id, row: row); reorder = true }
                if let index = row.index, positions[id] != index { positions[id] = index; reorder = true }
            } else if blocks.removeValue(forKey: id) != nil {
                positions.removeValue(forKey: id)
                reorder = true
            }
        case .blockPosition(_, _, let id, let index):
            positions[id] = index
            reorder = true
        case .controls(_, _, let row):
            controls = row
            if row?.busy != true { stopping = false; stopRequest = nil }
        case .history(_, _, let older, let loading):
            hasOlder = older
            loadingOlder = loading
        case .queue(_, _, let row):
            queue = row
        case .models(_, _, let state, let list):
            modelsState = state
            models = list
        default: break
        }
    }
    /// The Stop sent as `id` failed or was refused: offer Stop again unless a newer one is in flight.
    func stopFailed(_ id: String) {
        guard stopRequest == id else { return }
        stopRequest = nil
        stopping = false
    }
    /// Ends a frame: one ordering pass when membership or positions moved.
    func commit() {
        guard reorder else { return }
        reorder = false
        blockOrder = positions.keys.filter { blocks[$0] != nil }.sorted { (positions[$0] ?? 0) < (positions[$1] ?? 0) }
    }
}

extension BridgePatch {
    /// The thread and navigation generation a thread-screen patch belongs to.
    var screenScope: (thread: String, epoch: Int)? {
        switch self {
        case .block(let id, let epoch, _, _), .blockPosition(let id, let epoch, _, _): (id, epoch)
        case .controls(let id, let epoch, _), .history(let id, let epoch, _, _), .models(let id, let epoch, _, _), .queue(let id, let epoch, _): (id, epoch)
        default: nil
        }
    }
}
