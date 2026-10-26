import Foundation
import Observation

/// One finished turn's steps as read from the daemon, assembled from its pages.
@MainActor @Observable final class TurnStepsModel {
    var header: StepsHeader?
    var pages: [Int: [TranscriptRow]] = [:]
    /// The steps in order, up to the pages delivered so far.
    var rows: [TranscriptRow] {
        let count = header?.pages ?? pages.count
        return (0..<count).flatMap { pages[$0] ?? [] }
    }
}

/// A native subagent's own blocks, grouped as the transcript is, for its lane sheet.
@MainActor @Observable final class LaneModel {
    let agentId: String
    var blocks: [String: BlockModel] = [:]
    var order: [String] = []
    @ObservationIgnored private var positions: [String: Int] = [:]
    init(agentId: String) { self.agentId = agentId }
    func apply(_ id: String, row: BlockRow?) {
        if let row {
            if let block = blocks[id] { if block.row != row { block.row = row } } else { blocks[id] = BlockModel(id: id, row: row) }
            if let index = row.index { positions[id] = index }
        } else {
            blocks.removeValue(forKey: id)
            positions.removeValue(forKey: id)
        }
        reorder()
    }
    func move(_ id: String, to index: Int?) {
        positions[id] = index
        reorder()
    }
    private func reorder() {
        let next = positions.keys.filter { blocks[$0] != nil }.sorted { (positions[$0] ?? 0) < (positions[$1] ?? 0) }
        if next != order { order = next }
    }
}

extension ThreadScreenModel {
    /// Steps, effort and speed, attachments and the open lane.
    func apply(_ patch: ScreenPatch) {
        switch patch {
        case .steps(let header):
            // The same header again (a log opened again) changes nothing on screen.
            let steps = turnSteps(header.ordinal)
            if steps.header != header { steps.header = header }
            for page in steps.pages.keys where page >= header.pages { steps.pages[page] = nil }
        case .stepsPage(let ordinal, let page, let rows):
            let steps = turnSteps(ordinal)
            if steps.pages[page] != rows { steps.pages[page] = rows }
        case .stepsReleased(let ordinal):
            steps[ordinal] = nil
        case .tune(let row): if tune != row { tune = row }
        case .access(let row): if access != row { access = row }
        case .attachments(let files): if attachments != files { attachments = files }
        case .pill(let row, let goal):
            if pill != row { pill = row }
            if self.goal != goal { self.goal = goal }
        case .continued(let id): continued = id
        case .laneBlock(let agentId, let id, let row):
            if lane?.agentId == agentId { lane?.apply(id, row: row) }
        case .laneBlockPosition(let agentId, let id, let index):
            if lane?.agentId == agentId { lane?.move(id, to: index) }
        }
    }
    private func turnSteps(_ ordinal: Int) -> TurnStepsModel {
        if let steps = steps[ordinal] { return steps }
        let steps = TurnStepsModel()
        self.steps[ordinal] = steps
        return steps
    }
}
