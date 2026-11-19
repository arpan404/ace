import Foundation

extension ThreadModel {
    /// Bound for a staged replacement: the SDK tail never exceeds this, so a larger
    /// staging means a corrupt frame, not a longer thread.
    nonisolated static let snapshotItemBound = 2200
    /// Bounded evidence of items that left the visible order, newest last.
    nonisolated static let removalLogBound = 50

    /// Keep the readable snapshot while the bridge sends a replacement over several
    /// frames. Both cold resets and warm diffs stage; the visible rows never move
    /// until the matching ready fence commits.
    func beginSnapshot(revision: Int?, warm: Bool, before: Int?) {
        let incoming = ThreadModel(id: id)
        incoming.epoch = epoch
        if warm {
            // A warm diff only carries what changed: unchanged patches are suppressed
            // by the ledger, so seed the staging copy from the visible state first.
            // Row and block models are new objects holding copied value rows, so later
            // staging patches never mutate what is on screen.
            for (id, item) in items { incoming.items[id] = ItemModel(item.row) }
            incoming.positions = positions
            incoming.order = order
            incoming.interactions = interactions
            incoming.metadata = metadata
            incoming.metadataCurrent = metadataCurrent
            incoming.cursor = cursor
            incoming.recentRemovals = recentRemovals
            incoming.screen.seed(from: screen)
        }
        incoming.screen.stopping = screen.stopping
        incoming.screen.stopRequest = screen.stopRequest
        refresh = incoming
        refreshRevision = revision
        refreshBefore = before
        requiresSnapshot = true
        metadataCurrent = false
    }

    /// Legacy cold begin without an explicit revision (older bridges, recorded tests).
    func beginRefresh() {
        beginSnapshot(revision: nil, warm: false, before: nil)
    }

    /// Discard staging without publishing: navigation, a newer begin, a failed fence
    /// or a bound breach. The old readable rows stay; the next open is cold.
    func cancelSnapshot() {
        refresh = nil
        refreshRevision = nil
        refreshBefore = nil
        requiresSnapshot = true
        metadataCurrent = false
    }

    /// Publish only after all transcript rows have arrived. Existing row objects keep
    /// their identity, so a replacement does not discard disclosures, media or Markdown
    /// state. Returns false when the fence does not match the staging: nothing shows.
    @discardableResult
    func commitSnapshot(revision: Int?, count: Int) -> Bool {
        guard let incoming = refresh else { return false }
        if let revision, let staged = refreshRevision, revision != staged { return false }
        if revision != nil && refreshRevision == nil {
            // A revisioned fence must not commit an unrevisioned staging, unless the
            // staging is empty and the fence expects empty (legacy cold open of nothing).
            if !(incoming.order.isEmpty && incoming.items.isEmpty && count == 0) { return false }
        }
        // The fence must describe exactly what staged: otherwise a split frame or a
        // superseded pass would show a partial transcript.
        incoming.reorder()
        guard incoming.order.count == count else { return false }
        guard incoming.items.count <= Self.snapshotItemBound else {
            cancelSnapshot()
            return false
        }
        for (id, item) in incoming.items {
            if let kept = items[id] { kept.row = item.row; incoming.items[id] = kept }
        }
        items = incoming.items
        positions = incoming.positions
        order = incoming.order
        interactions = incoming.interactions
        metadata = incoming.metadata
        metadataCurrent = incoming.metadataCurrent
        cursor = incoming.cursor
        recentRemovals = incoming.recentRemovals
        screen.replace(with: incoming.screen)
        refresh = nil
        refreshRevision = nil
        refreshBefore = nil
        return true
    }

    /// Publish only after all transcript rows have arrived. Existing row objects keep their
    /// identity, so a replacement does not discard disclosures, media or Markdown state.
    func finishRefresh() {
        guard let incoming = refresh else { return }
        // Legacy path without an explicit fence: preserve the previous unconditional
        // publish for recorded tests that stage without a count.
        for (id, item) in incoming.items {
            if let kept = items[id] { kept.row = item.row; incoming.items[id] = kept }
        }
        items = incoming.items
        positions = incoming.positions
        incoming.reorder()
        order = incoming.order
        interactions = incoming.interactions
        metadata = incoming.metadata
        metadataCurrent = incoming.metadataCurrent
        cursor = incoming.cursor
        screen.replace(with: incoming.screen)
        refresh = nil
        refreshRevision = nil
        refreshBefore = nil
    }

    /// Record that `id` left the visible order, with the bridge's evidence when known.
    /// Bounded: only the newest entries are kept for the viewport's successor choice.
    func noteRemoval(id: String, seq: Int?, reason: String?) {
        recentRemovals.removeAll { $0.id == id }
        recentRemovals.append(ThreadItemRemoval(id: id, seq: seq, reason: reason))
        while recentRemovals.count > Self.removalLogBound { recentRemovals.removeFirst() }
    }
}
