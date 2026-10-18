import Foundation
import Observation

@MainActor @Observable final class BlockModel: Identifiable {
    let id: String
    var row: BlockRow
    init(id: String, row: BlockRow) { self.id = id; self.row = row }
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
    /// Stop was pressed; cleared when the tree stops working.
    var stopping = false
    @ObservationIgnored private var positions: [String: Int] = [:]
    @ObservationIgnored private var reorder = false

    func reset() {
        blocks.removeAll(keepingCapacity: true)
        positions.removeAll(keepingCapacity: true)
        blockOrder = []
        controls = nil
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
            if row?.busy != true { stopping = false }
        case .history(_, _, let older, let loading):
            hasOlder = older
            loadingOlder = loading
        case .models(_, _, let state, let list):
            modelsState = state
            models = list
        default: break
        }
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
        case .controls(let id, let epoch, _), .history(let id, let epoch, _, _), .models(let id, let epoch, _, _): (id, epoch)
        default: nil
        }
    }
}
