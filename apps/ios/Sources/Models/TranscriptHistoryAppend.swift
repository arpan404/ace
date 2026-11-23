import Foundation

/// An older page may publish during a fling when all the rows between the live edge and
/// the newly loaded rows keep their order and size. The only removals this admits are
/// newer rows whose measured space the extent will retain.
enum TranscriptHistoryAppend {
    @MainActor static func preservesRows(_ patches: [BridgePatch], replacing base: ThreadModel,
                                        shown: ThreadModel, retainedNewer: Set<String>) -> Bool {
        let before = shown.screen.blockOrder
        let surviving = Array(before.dropLast(retainedNewer.count))
        guard !surviving.isEmpty, Set(before.suffix(retainedNewer.count)) == retainedNewer else { return false }
        let survivors = Set(surviving)
        let visibleItems = Set(surviving.flatMap { shown.screen.blocks[$0]?.row.items ?? [] })
        var positions = base.screen.blockPositions
        var added = false

        for patch in patches {
            switch patch {
            case .threadReset, .snapshotBegin:
                guard base !== shown else { return false }
                positions.removeAll()
            case .block(_, _, let id, let row):
                if survivors.contains(id) {
                    guard let row, let previous = shown.screen.blocks[id]?.row,
                          row.sameExceptPosition(as: previous) else { return false }
                }
                if let row {
                    if let index = row.index { positions[id] = index }
                    if !survivors.contains(id), !retainedNewer.contains(id) { added = true }
                } else {
                    positions[id] = nil
                }
            case .blockPosition(_, _, let id, let index):
                positions[id] = index
            case .item(_, _, let id, let row, _) where visibleItems.contains(id):
                guard let row, let previous = shown.items[id]?.row,
                      row.sameExceptPosition(as: previous) else { return false }
            case .itemText(_, _, let id, _, _) where visibleItems.contains(id):
                return false
            default:
                break
            }
        }
        guard added, retainedNewer.isDisjoint(with: positions.keys), Set(positions.values).count == positions.count
        else { return false }
        let order = positions.sorted { $0.value < $1.value }.map(\.key)
        return order.suffix(surviving.count).elementsEqual(surviving)
    }
}
