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
    var modelList = ThreadModels()
    var modelsState: String { modelList.state }
    /// A thread this one continued in, to open once; cleared when opened.
    var continued: String?
    /// A move the bridge asks to be confirmed; the model sheet asks it and clears it.
    var switchAsk: SwitchAsk?
    /// Follow-ups waiting in the daemon's queue, outside the transcript until delivered.
    var queue: QueueRow?
    /// Stop was pressed; cleared when the tree stops working, or when this Stop's own request
    /// fails to save or is refused while the tree keeps working.
    var stopping = false
    /// Whether a block patch adds, removes or moves a block, rather than redrawing one in place.
    func moves(_ patch: BridgePatch) -> Bool {
        switch patch {
        case .blockPosition(_, _, let id, let index): return positions[id] != index
        case .block(_, _, let id, let row):
            guard let row else { return blocks[id] != nil }
            return blocks[id] == nil || row.index.map { positions[id] != $0 } == true
        default: return false
        }
    }
    /// The local request id of the Stop in flight, so a late result of an older one is ignored.
    @ObservationIgnored var stopRequest: String?
    /// Finished turns' steps read on demand, by turn ordinal.
    var steps: [Int: TurnStepsModel] = [:]
    /// The live pill over the composer; nil when nothing is live, queued or pursued.
    var pill: PillRow?
    /// The thread's goal, for its sheet; nil without one.
    var goal: GoalRow?
    /// Subagent groups the person opened, by block id. Kept across a reload of the thread, so
    /// coming back from a child finds the group as it was left.
    var openGroups: Set<String> = []
    /// Effort and speed for the next message.
    var tune: TuneRow?
    /// The thread's access and the modes it can change to (`thread.access`).
    var access: ThreadAccessRow?
    /// Files on the next message and their uploads.
    var attachments: [AttachmentFile] = []
    /// Why no file can be added now, while a message starting a new thread is on its way.
    var attachmentsLocked: String?
    /// Browser annotations on the next message.
    var annotations: [AnnotationChip] = []
    /// The native subagent lane open in its sheet.
    var lane: LaneModel?
    /// What the menu and messages offer (`thread.transitions`).
    var transitions: TransitionsRow?
    /// The fork the composer writes; nil while it writes to this thread.
    var fork: ForkDraftRow?
    /// Bring back to parent's starting summary, once read.
    var mergeDraft: MergeDraftRow?
    /// What stops the checkout, shown above the composer.
    var work: WorkLine?
    /// The thread's latest Offshift run, worded against the whole tree; nil while it has none.
    var offshift: OffshiftRun?
    @ObservationIgnored private var positions: [String: Int] = [:]
    @ObservationIgnored private var reorder = false

    /// Seed a warm staging copy from the visible screen with independent block
    /// objects. Block rows are value types copied into new models, so later block
    /// patches mutate only the staging copy. Visit-owned holders (steps, lane)
    /// are shared by reference: snapshot patches never mutate them in place.
    func seed(from shown: ThreadScreenModel) {
        var seeded: [String: BlockModel] = [:]
        seeded.reserveCapacity(shown.blocks.count)
        for (id, block) in shown.blocks { seeded[id] = BlockModel(id: id, row: block.row) }
        blocks = seeded
        blockOrder = shown.blockOrder
        positions = shown.positions
        reorder = false
        controls = shown.controls
        hasOlder = shown.hasOlder
        modelList = shown.modelList
        continued = shown.continued
        switchAsk = shown.switchAsk
        queue = shown.queue
        stopping = shown.stopping
        stopRequest = shown.stopRequest
        steps = shown.steps
        pill = shown.pill
        goal = shown.goal
        openGroups = shown.openGroups
        tune = shown.tune
        access = shown.access
        attachments = shown.attachments
        attachmentsLocked = shown.attachmentsLocked
        annotations = shown.annotations
        lane = shown.lane
        transitions = shown.transitions
        fork = shown.fork
        mergeDraft = shown.mergeDraft
        work = shown.work
        offshift = shown.offshift
    }

    /// Replace a completed snapshot without removing rows between bridge frames.
    func replace(with incoming: ThreadScreenModel) {
        incoming.commit()
        for (id, block) in incoming.blocks {
            if let kept = blocks[id] { kept.row = block.row; incoming.blocks[id] = kept }
        }
        blocks = incoming.blocks
        blockOrder = incoming.blockOrder
        positions = incoming.positions
        reorder = false
        controls = incoming.controls
        hasOlder = incoming.hasOlder
        modelList = incoming.modelList
        continued = incoming.continued
        switchAsk = incoming.switchAsk
        queue = incoming.queue
        stopping = incoming.stopping
        stopRequest = incoming.stopRequest
        steps = incoming.steps
        pill = incoming.pill
        goal = incoming.goal
        tune = incoming.tune
        access = incoming.access
        attachments = incoming.attachments
        attachmentsLocked = incoming.attachmentsLocked
        annotations = incoming.annotations
        lane = incoming.lane
        transitions = incoming.transitions
        fork = incoming.fork
        mergeDraft = incoming.mergeDraft
        work = incoming.work
        offshift = incoming.offshift
    }

    func reset() {
        blocks.removeAll(keepingCapacity: true)
        positions.removeAll(keepingCapacity: true)
        blockOrder = []
        controls = nil
        queue = nil
        pill = nil
        goal = nil
        offshift = nil
        steps = [:]
        tune = nil
        access = nil
        attachments = []
        transitions = nil
        fork = nil
        mergeDraft = nil
        work = nil
        attachmentsLocked = nil
        annotations = []
        hasOlder = false
    }
    /// Opening a kept thread again: what belonged to the last visit's bridge session goes (its
    /// steps, lane, files and model list are read again on request); the transcript stays.
    func revisit() {
        steps = [:]
        lane = nil
        attachments = []
        attachmentsLocked = nil
        annotations = []
        modelList = ThreadModels()
        // The last visit's fork was its bridge session's; a new one starts on this thread.
        fork = nil
        mergeDraft = nil
        stopping = false
        stopRequest = nil
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
        case .history(_, _, let older):
            hasOlder = older
        case .queue(_, _, let row):
            queue = row
        case .models(_, _, let list):
            modelList = list
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
    /// The thread and generation any thread-scoped patch belongs to: the open thread's or the
    /// reading view's.
    var threadScope: (thread: String, epoch: Int)? {
        switch self {
        case .threadReset(let id, let epoch, _, _), .snapshotBegin(let id, let epoch, _, _),
             .position(let id, let epoch, _, _), .item(let id, let epoch, _, _, _),
             .itemText(let id, let epoch, _, _, _), .metadata(let id, let epoch, _), .interaction(let id, let epoch, _, _),
             .cursor(let id, let epoch, _), .ready(let id, let epoch, _, _), .readingSettled(let id, let epoch): (id, epoch)
        default: screenScope
        }
    }
    /// The thread and navigation generation a thread-screen patch belongs to.
    var screenScope: (thread: String, epoch: Int)? {
        switch self {
        case .block(let id, let epoch, _, _), .blockPosition(let id, let epoch, _, _): (id, epoch)
        case .controls(let id, let epoch, _), .history(let id, let epoch, _), .models(let id, let epoch, _), .queue(let id, let epoch, _): (id, epoch)
        default: nil
        }
    }
}
