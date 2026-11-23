import Foundation

/// An older page may fill or regroup rows ahead of the viewport during a fling. The rows
/// between the viewport and the live edge keep their order and size, or leave measured space.
enum TranscriptHistoryAppend {
    @MainActor static func preservesRows(_ patches: [BridgePatch], replacing base: ThreadModel,
                                        shown: ThreadModel, oldestProtected: String?, retainedNewer: Set<String>) -> Bool {
        let before = shown.screen.blockOrder
        let surviving = before.dropLast(retainedNewer.count)
        guard !surviving.isEmpty, Set(before.suffix(retainedNewer.count)) == retainedNewer else { return false }
        let first = oldestProtected.flatMap { surviving.firstIndex(of: $0) } ?? surviving.startIndex
        let protected = surviving[first...]
        let protectedIDs = Set(protected)
        let protectedItems = Set(protected.flatMap { shown.screen.blocks[$0]?.row.items ?? [] })
        let previousIDs = Set(before)
        var positions = base.screen.blockPositions

        for patch in patches {
            switch patch {
            case .threadReset, .snapshotBegin:
                guard base !== shown else { return false }
                positions.removeAll()
            case .block(_, _, let id, let row):
                if protectedIDs.contains(id) {
                    guard let row, let previous = shown.screen.blocks[id]?.row,
                          row.sameExceptPosition(as: previous) else { return false }
                }
                if let row {
                    if let index = row.index { positions[id] = index }
                } else {
                    positions[id] = nil
                }
            case .blockPosition(_, _, let id, let index):
                positions[id] = index
            case .item(_, _, let id, let row, _) where protectedItems.contains(id):
                guard let row, let previous = shown.items[id]?.row,
                      row.sameExceptPosition(as: previous) else { return false }
            case .itemText(_, _, let id, _, _) where protectedItems.contains(id):
                return false
            default:
                break
            }
        }
        guard positions.keys.contains(where: { !previousIDs.contains($0) }),
              retainedNewer.isDisjoint(with: positions.keys),
              Set(positions.values).count == positions.count else { return false }
        let order = positions.sorted { $0.value < $1.value }.map(\.key)
        return order.suffix(protected.count).elementsEqual(protected)
    }
}
