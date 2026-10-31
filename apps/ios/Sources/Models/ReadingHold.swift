import Foundation

/// Bounded, coalescing hold for reading-window patches while the person scrolls or a
/// page settles. Pure value: no I/O, no clock, no singletons. Latest wins per key,
/// preserving reset/delete/order semantics; a reset clears, a deletion replaces the
/// row and is never resurrected by an older put.
///
/// Bounds: at most `maxPatches` patches and `maxBytes` estimated bytes. Past either,
/// the hold discards everything and waits for the next reset (fresh snapshot
/// recovery): intermediate deltas are lost, but the next complete page supersedes
/// them, frames are still acknowledged, and `needsFresh` tells the viewport to
/// re-read when no fresh reset arrives on its own.
struct ReadingHold: Sendable {
    /// One full valid history window must fit: the phone window holds 400 rows
    /// and 2 MiB of text, plus a position per row, its blocks and a few status
    /// patches. Past this, the hold discards to the next fresh reset.
    nonisolated static let maxPatches = 4096
    nonisolated static let maxBytes = 3 * 1024 * 1024

    private var keys: [String] = []
    private var values: [String: (patch: BridgePatch, bytes: Int)] = [:]
    private var unkeyed = 0
    private(set) var bytes = 0
    /// Discarding everything until the next reset after an overflow.
    private(set) var awaitingFresh = false
    /// An overflow happened and no fresh snapshot has flushed yet.
    private(set) var needsFresh = false

    var isEmpty: Bool { keys.isEmpty }
    var count: Int { keys.count }

    mutating func append(_ patch: BridgePatch) {
        // A fresh snapshot start recovers from overflow: hold from here on.
        if awaitingFresh {
            switch patch {
            case .threadReset, .snapshotBegin:
                awaitingFresh = false
                storeFreshStart(patch)
            default:
                break
            }
            return
        }
        switch patch {
        case .threadReset, .snapshotBegin:
            keys.removeAll(keepingCapacity: true)
            values.removeAll(keepingCapacity: true)
            bytes = 0
            unkeyed = 0
            store(patch, key: Self.resetKey)
        default:
            guard let key = Self.key(patch) else {
                unkeyed += 1
                store(patch, key: "unkeyed:\(unkeyed)")
                enforceBounds()
                return
            }
            store(patch, key: key)
        }
        enforceBounds()
    }

    mutating func take() -> [BridgePatch] {
        let patches = keys.compactMap { values[$0]?.patch }
        let startedFresh: Bool = {
            guard let first = patches.first else { return false }
            switch first {
            case .threadReset, .snapshotBegin: return true
            default: return false
            }
        }()
        keys.removeAll(keepingCapacity: true)
        values.removeAll(keepingCapacity: true)
        bytes = 0
        unkeyed = 0
        if startedFresh { awaitingFresh = false; needsFresh = false }
        return patches
    }

    mutating func clear() {
        keys.removeAll(keepingCapacity: true)
        values.removeAll(keepingCapacity: true)
        bytes = 0
        unkeyed = 0
        awaitingFresh = false
        needsFresh = false
    }

    private mutating func store(_ patch: BridgePatch, key: String) {
        let size = Self.estimatedBytes(patch)
        if let old = values[key] {
            bytes -= old.bytes
        } else {
            keys.append(key)
        }
        values[key] = (patch, size)
        bytes += size
    }

    private mutating func storeFreshStart(_ patch: BridgePatch) {
        keys.removeAll(keepingCapacity: true)
        values.removeAll(keepingCapacity: true)
        bytes = 0
        unkeyed = 0
        store(patch, key: Self.resetKey)
        // needsFresh stays true until this fresh snapshot flushes.
    }

    private mutating func enforceBounds() {
        guard keys.count > Self.maxPatches || bytes > Self.maxBytes else { return }
        keys.removeAll(keepingCapacity: true)
        values.removeAll(keepingCapacity: true)
        bytes = 0
        unkeyed = 0
        awaitingFresh = true
        needsFresh = true
    }

    nonisolated static let resetKey = "reset"

    /// Coalescing identity for reading patches. Nil means uncoalescible: each patch kept.
    static func key(_ patch: BridgePatch) -> String? {
        switch patch {
        case .threadReset, .snapshotBegin:
            return resetKey
        case .position(_, _, let itemId, _):
            return "position:\(itemId)"
        case .item(_, _, let itemId, _, _):
            return "item:\(itemId)"
        case .itemText(_, _, let itemId, _, _):
            return "item:\(itemId)"
        case .metadata:
            return "metadata"
        case .interaction(_, _, let interactionId, _):
            return "interaction:\(interactionId)"
        case .cursor:
            return "cursor"
        case .ready:
            return "ready"
        case .block(_, _, let id, _):
            return "block:\(id)"
        case .blockPosition(_, _, let id, _):
            return "blockPosition:\(id)"
        case .controls:
            return "controls"
        case .history:
            return "history"
        case .models:
            return "models"
        case .queue:
            return "queue"
        default:
            return nil
        }
    }

    /// Estimated UTF-8 bytes for bounding. Conservative, deterministic, no I/O.
    static func estimatedBytes(_ patch: BridgePatch) -> Int {
        switch patch {
        case .item(_, _, _, let row, _):
            guard let row else { return 200 }
            return 300 + row.text.utf8.count + (row.detail?.utf8.count ?? 0)
        case .itemText(_, _, _, let edit, let row):
            return 300 + edit.append.utf8.count + row.text.utf8.count
        case .block(_, _, _, let row):
            guard let row else { return 200 }
            return 500 + row.items.count * 50
        default:
            return 300
        }
    }
}
