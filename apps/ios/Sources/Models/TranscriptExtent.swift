import Foundation
import Observation

/// A block's creation-sequence span in the canonical history: first and last
/// item sequence, inclusive. Grounds distant retained segments (the service
/// reply's `blockSeqs`, keyed by raw block ID) so rehydrated ranges shrink
/// instead of haunting the extent forever.
struct BlockSeqSpan: Decodable, Equatable, Sendable {
    var first: Int
    var last: Int
}

/// The logical space of visited history, independently of the bounded resident message window.

/// The logical space of visited history, independently of the bounded resident message window.
/// Evicted rows keep only an id and height here; their contents stay in the SDK's disk cache.
/// Paging touches the old and new resident windows, never scans all visited history.
///
/// Memory is bounded on every axis:
/// - measured heights are capped (`maxMeasured`);
/// - nearby retained spacer IDs are capped (`maxSpacers`) and dropped past it;
/// - distant space lives only in sequence-grounded compact segments
///   (`maxSegments`); unbounded far-height totals are never kept, because a
///   total without sequence bounds cannot shrink on rehydration and would haunt
///   the extent forever.
/// Measurements are keyed by layout revision: a width, type-size, density or
/// disclosure change invalidates cached heights so offscreen spacers never
/// describe an earlier layout.
@MainActor @Observable final class TranscriptExtent {
    enum Movement { case older, newer, replace }

    /// Explicit window change with semantic evidence. Every row missing from
    /// the new resident window must be classified:
    /// - `evicted` rows still exist in canonical history (keep their spacer);
    /// - `deleted` rows were authoritatively deleted or regrouped (never keep);
    /// - anything unclassified is ambiguous and is dropped: inferring deletion
    ///   from array edges alone caused phantom spacers, so only semantic
    ///   evidence retains space.
    /// `spans` carries the resident blocks' creation-sequence spans keyed by
    /// raw block ID (`blockSeqs` from the service reply). An evicted block
    /// with a span lying wholly outside the new window folds into a
    /// sequence-grounded segment; without a span it stays nearby and bounded.
    /// `beforeSeq`/`afterSeq` are the window's exclusive cursors;
    /// `beforeCount`/`afterCount` are distant retained counts that only ever
    /// shrink retained space, never grow it.
    struct WindowChange: Equatable, Sendable {
        var ids: [String]
        var movement: Movement
        var evicted: [String] = []
        var deleted: [String] = []
        var beforeSeq: Int? = nil
        var afterSeq: Int? = nil
        var beforeCount: Int? = nil
        var afterCount: Int? = nil
        var spans: [String: BlockSeqSpan]? = nil
    }

    /// One distant retained range: creation-sequence bounds with the measured
    /// height and row count folded into it. Bounded in number; rehydration
    /// subtracts exact heights back out, so segments never outlive the ranges
    /// they describe.
    struct SeqSegment: Equatable, Sendable {
        var first: Int
        var last: Int
        var height: Double
        var count: Int
    }

    /// Retained spacer IDs are capped; beyond that the oldest are dropped.
    /// The resident window holds at most ~400 blocks.
    static let maxMeasured = 1_000
    static let maxSpacers = 1_200
    /// Compact distant segments are capped; adjacent ones coalesce.
    static let maxSegments = 64
    static let fallbackEstimate = 44.0

    private(set) var before: Double = 0
    private(set) var after: Double = 0
    /// Sequence-grounded distant ranges, ordered by `first`.
    private(set) var segments: [SeqSegment] = []
    private(set) var revision = TranscriptLayoutRevision.default
    @ObservationIgnored private var resident: [String] = []
    @ObservationIgnored private var heights: [String: Double] = [:]
    @ObservationIgnored private var leading: [String: Double] = [:]
    @ObservationIgnored private var trailing: [String: Double] = [:]
    /// Insertion order of retained spacer IDs, oldest first, for the cap.
    @ObservationIgnored private var spacerOrder: [(trailing: Bool, id: String)] = []
    /// Measure insertion order, oldest first, for the heights cap.
    @ObservationIgnored private var measureOrder: [String] = []
    @ObservationIgnored private var measuredTotal: Double = 0
    @ObservationIgnored private var measuredCount = 0
    /// The resident window's creation-sequence range, when spans ground it.
    @ObservationIgnored private var residentFirst: Int?
    @ObservationIgnored private var residentLast: Int?

    var spacerCount: Int { leading.count + trailing.count }
    var segmentCount: Int { segments.count }
    var segmentRows: Int { segments.reduce(0) { $0 + $1.count } }

    /// Measurements outlive lazy views, including the row's inter-message spacing.
    func measure(_ id: String, height: Double) {
        measure(id, height: height, revision: revision)
    }

    /// Measured `height` under `measured`: a stale revision never sizes space.
    func measure(_ id: String, height: Double, revision measured: TranscriptLayoutRevision) {
        guard height.isFinite, height >= 0 else { return }
        guard measured == revision else { return }
        if heights[id] == nil {
            measureOrder.append(id)
            measuredCount += 1
        } else {
            measuredTotal -= heights[id] ?? 0
        }
        heights[id] = height
        measuredTotal += height
        trimMeasured()
        if let old = leading[id] { leading[id] = height; before = max(0, before + height - old) }
        if let old = trailing[id] { trailing[id] = height; after = max(0, after + height - old) }
    }

    /// A layout revision change invalidates cached heights: offscreen spacers
    /// fall back to count-based estimates until rows remeasure, instead of
    /// describing the earlier layout indefinitely. Segments keep their counts
    /// with estimate heights; the next reply's counts and spans re-ground them.
    func applyRevision(_ next: TranscriptLayoutRevision) {
        guard next != revision else { return }
        revision = next
        heights.removeAll()
        measureOrder.removeAll()
        measuredTotal = 0
        measuredCount = 0
        for id in leading.keys { leading[id] = Self.fallbackEstimate }
        for id in trailing.keys { trailing[id] = Self.fallbackEstimate }
        for index in segments.indices {
            segments[index].height = Double(segments[index].count) * Self.fallbackEstimate
        }
        recomputeTotals()
    }

    func needsContent(top: Double, bottom: Double) -> Bool {
        (before > 0 && top < before) || (after > 0 && bottom < after)
    }

    func edge(top: Double, bottom: Double, ahead: Double, direction: Int) -> Movement? {
        if direction < 0, top - before < ahead { return .older }
        if direction > 0, bottom - after < ahead { return .newer }
        return nil
    }

    /// Explicit change with semantic evidence. Only `evicted` rows retain
    /// space; `deleted` rows are dropped; ambiguous rows are dropped. An
    /// evicted block whose span lies wholly outside the new window folds into
    /// a sequence-grounded segment; an evicted block without a span stays
    /// nearby and bounded. Rehydrated ranges subtract back out.
    func update(change: WindowChange) {
        if change.movement == .replace {
            replace(with: change.ids)
            return
        }
        let previous = Set(resident)
        let kept = Set(change.ids)
        let evicted = Set(change.evicted)
        let estimate = estimateHeight()
        let (newFirst, newLast) = windowRange(ids: change.ids, spans: change.spans,
                                              beforeSeq: change.beforeSeq, afterSeq: change.afterSeq)
        for (index, id) in resident.enumerated() where !kept.contains(id) {
            guard evicted.contains(id) else {
                // Deleted, regrouped or ambiguous: never spacers. Drop cached
                // heights too so ID reuse cannot misattribute stale sizes.
                if let old = heights.removeValue(forKey: id) {
                    measuredTotal -= old
                    measuredCount -= 1
                }
                measureOrder.removeAll { $0 == id }
                continue
            }
            let height = heights[id] ?? estimate
            if let span = change.spans?[Self.raw(id)] {
                // Sequence-grounded: only a span wholly outside the new window
                // may retain space; an interleaved span is a regroup overlap.
                if let first = newFirst, span.last < first {
                    foldSegment(first: span.first, last: span.last, height: height)
                } else if let last = newLast, span.first > last {
                    foldSegment(first: span.first, last: span.last, height: height)
                }
                continue
            }
            // No span: nearby positional retention, bounded by the spacer cap.
            let first = resident.firstIndex { kept.contains($0) }
            let last = resident.lastIndex { kept.contains($0) }
            if let first, index < first {
                retainLeading(id, height: height)
            } else if let last, index > last {
                retainTrailing(id, height: height)
            } else if first == nil {
                if change.movement == .older {
                    retainTrailing(id, height: height)
                } else {
                    retainLeading(id, height: height)
                }
            }
        }
        for id in change.ids {
            if let height = leading.removeValue(forKey: id) {
                before = max(0, before - height)
                spacerOrder.removeAll { !$0.trailing && $0.id == id }
            }
            if let height = trailing.removeValue(forKey: id) {
                after = max(0, after - height)
                spacerOrder.removeAll { $0.trailing && $0.id == id }
            }
            if !previous.contains(id), let span = change.spans?[Self.raw(id)] {
                rehydrate(span: span, height: heights[id] ?? estimate)
            }
        }
        resident = change.ids
        if change.ids.isEmpty {
            // Nothing resident: no range to ground distant space against.
            segments.removeAll()
            residentFirst = nil
            residentLast = nil
        }
        updateResidentRange(ids: change.ids, spans: change.spans,
                            beforeSeq: change.beforeSeq, afterSeq: change.afterSeq)
        trimSpacers()
        // Explicit cursors ground retained space: when the bridge reports fewer
        // distant rows than retained, the hydrated ranges stop describing
        // space. Counts only ever shrink retained space, never grow it.
        if let target = change.beforeCount { groundSide(leading: true, to: target) }
        if let target = change.afterCount { groundSide(leading: false, to: target) }
        recomputeTotals()
    }

    /// Legacy paging update without semantic evidence. Kept for compatibility
    /// with bridges that predate range metadata: every missing edge row is
    /// treated as evicted, as before. Any window that can shrink by deletion
    /// or regrouping must use `update(change:)` instead.
    func update(_ ids: [String], movement: Movement) {
        if movement == .replace {
            replace(with: ids)
            return
        }
        guard ids != resident else { return }
        let kept = Set(ids)
        let first = resident.firstIndex { kept.contains($0) }
        let last = resident.lastIndex { kept.contains($0) }
        // An unmeasured row gets a stable estimate at eviction, refined when it is visited.
        let estimate = estimateHeight()
        for (index, id) in resident.enumerated() where !kept.contains(id) {
            let height = heights[id] ?? estimate
            if let first, index < first {
                retainLeading(id, height: height)
            } else if let last, index > last {
                retainTrailing(id, height: height)
            } else if first == nil {
                if movement == .older {
                    retainTrailing(id, height: height)
                } else {
                    retainLeading(id, height: height)
                }
            } else if let old = heights.removeValue(forKey: id) {
                // Regrouped/deleted blocks within the resident range are not virtualized rows.
                measuredTotal -= old; measuredCount -= 1
            }
        }
        for id in ids {
            if let height = leading.removeValue(forKey: id) {
                before = max(0, before - height)
                spacerOrder.removeAll { !$0.trailing && $0.id == id }
            }
            if let height = trailing.removeValue(forKey: id) {
                after = max(0, after - height)
                spacerOrder.removeAll { $0.trailing && $0.id == id }
            }
        }
        resident = ids
        if ids.isEmpty {
            segments.removeAll()
            residentFirst = nil
            residentLast = nil
        }
        trimSpacers()
        recomputeTotals()
    }

    // MARK: - Sequence-grounded segments

    /// Fold one evicted block's measured height into the distant segments,
    /// coalescing adjacent ranges and keeping the segment count bounded.
    /// Counts are preserved exactly across merges.
    private func foldSegment(first: Int, last: Int, height: Double) {
        guard first <= last, height >= 0 else { return }
        segments.append(SeqSegment(first: first, last: last, height: height, count: 1))
        coalesceSegments()
    }

    private func coalesceSegments() {
        guard segments.count > 1 else { return }
        segments.sort { $0.first < $1.first }
        var merged: [SeqSegment] = []
        for segment in segments {
            if let tail = merged.last, segment.first <= tail.last + 1 {
                merged[merged.count - 1] = SeqSegment(
                    first: tail.first, last: max(tail.last, segment.last),
                    height: tail.height + segment.height, count: tail.count + segment.count)
            } else {
                merged.append(segment)
            }
        }
        segments = merged
        while segments.count > Self.maxSegments {
            // Merge the closest adjacent pair, preserving counts exactly.
            var best = 0
            var bestGap = Int.max
            for index in 0..<(segments.count - 1) {
                let gap = segments[index + 1].first - segments[index].last
                if gap < bestGap { bestGap = gap; best = index }
            }
            let left = segments[best]
            let right = segments[best + 1]
            segments[best] = SeqSegment(
                first: left.first, last: max(left.last, right.last),
                height: left.height + right.height, count: left.count + right.count)
            segments.remove(at: best + 1)
        }
    }

    /// A resident block's range rehydrated: subtract its height from the
    /// overlapping segment, removing the segment when it empties. Totals stay
    /// exact because folding added the same height.
    private func rehydrate(span: BlockSeqSpan, height: Double) {
        guard let index = overlappingSegment(span: span) else { return }
        segments[index].height = max(0, segments[index].height - height)
        segments[index].count = max(0, segments[index].count - 1)
        if segments[index].height <= 0 || segments[index].count <= 0 {
            segments.remove(at: index)
        }
    }

    private func overlappingSegment(span: BlockSeqSpan) -> Int? {
        var best: Int?
        var bestOverlap = 0
        for (index, segment) in segments.enumerated() {
            let overlap = min(segment.last, span.last) - max(segment.first, span.first)
            if overlap >= 0, overlap > bestOverlap { bestOverlap = overlap; best = index }
        }
        // Touching or containing ranges still describe the same history: fall
        // back to any intersecting segment.
        if best == nil {
            best = segments.firstIndex { $0.last >= span.first && $0.first <= span.last }
        }
        return best
    }

    /// Recompute the published totals from nearby spacers plus the segments
    /// lying outside the resident range. Segments fully covered by the resident
    /// window are dropped (their ranges hydrated); partially covered ones are
    /// trimmed to the uncovered part, scaled pro-rata.
    private func recomputeTotals() {
        if let first = residentFirst, let last = residentLast {
            var kept: [SeqSegment] = []
            for segment in segments {
                if segment.last < first || segment.first > last {
                    kept.append(segment)
                    continue
                }
                if segment.first >= first && segment.last <= last { continue }
                let width = Double(max(1, segment.last - segment.first + 1))
                if segment.first < first {
                    let keepWidth = Double(first - segment.first)
                    let fraction = max(0, min(1, keepWidth / width))
                    kept.append(SeqSegment(first: segment.first, last: first - 1,
                                           height: segment.height * fraction,
                                           count: Int((Double(segment.count) * fraction).rounded(.down))))
                } else {
                    let keepWidth = Double(segment.last - last)
                    let fraction = max(0, min(1, keepWidth / width))
                    kept.append(SeqSegment(first: last + 1, last: segment.last,
                                           height: segment.height * fraction,
                                           count: Int((Double(segment.count) * fraction).rounded(.down))))
                }
            }
            segments = kept.filter { $0.count > 0 && $0.height > 0 }
        }
        let first = residentFirst
        let last = residentLast
        let beforeSeg = segments.filter { segment in first.map { segment.last < $0 } ?? false }
            .reduce(0) { $0 + $1.height }
        let afterSeg = segments.filter { segment in last.map { segment.first > $0 } ?? true }
            .reduce(0) { $0 + $1.height }
        before = leading.values.reduce(0, +) + beforeSeg
        after = trailing.values.reduce(0, +) + afterSeg
    }

    /// The resident window's sequence range from its blocks' spans, falling
    /// back to the window's exclusive cursors.
    private func windowRange(ids: [String], spans: [String: BlockSeqSpan]?,
                             beforeSeq: Int?, afterSeq: Int?) -> (Int?, Int?) {
        let known = ids.compactMap { spans?[$0.hasPrefix("block:") ? String($0.dropFirst(6)) : $0] }
        let first = known.map(\.first).min() ?? beforeSeq.map { $0 + 1 }
        let last = known.map(\.last).max() ?? afterSeq
        return (first, last)
    }

    private func updateResidentRange(ids: [String], spans: [String: BlockSeqSpan]?,
                                     beforeSeq: Int?, afterSeq: Int?) {
        let (first, last) = windowRange(ids: ids, spans: spans, beforeSeq: beforeSeq, afterSeq: afterSeq)
        if first != nil { residentFirst = first }
        if last != nil { residentLast = last }
        if ids.isEmpty { residentFirst = nil; residentLast = nil }
    }

    // MARK: - Internals

    private static func raw(_ id: String) -> String {
        id.hasPrefix("block:") ? String(id.dropFirst(6)) : id
    }

    private func replace(with ids: [String]) {
        let kept = Set(ids)
        heights = heights.filter { kept.contains($0.key) }
        measureOrder.removeAll { !kept.contains($0) }
        measuredTotal = heights.values.reduce(0, +)
        measuredCount = heights.count
        leading = [:]; trailing = [:]
        spacerOrder.removeAll()
        segments.removeAll()
        residentFirst = nil; residentLast = nil
        before = 0; after = 0
        resident = ids
    }

    private func estimateHeight() -> Double {
        measuredCount > 0 ? measuredTotal / Double(measuredCount) : Self.fallbackEstimate
    }

    private func retainLeading(_ id: String, height: Double) {
        guard leading[id] == nil else { return }
        leading[id] = height
        before += height
        spacerOrder.append((trailing: false, id: id))
    }

    private func retainTrailing(_ id: String, height: Double) {
        guard trailing[id] == nil else { return }
        trailing[id] = height
        after += height
        spacerOrder.append((trailing: true, id: id))
    }

    /// Clamp one side's retained space to the bridge's distant count: folded
    /// segments shrink first (whole oldest on that side), then the oldest
    /// nearby spacers (by exact heights). Never grows space from counts.
    private func groundSide(leading isLeading: Bool, to target: Int) {
        let near = isLeading ? leading.count : trailing.count
        let sideSegments = isLeading ? segmentsBefore() : segmentsAfter()
        let far = sideSegments.reduce(0) { $0 + $1.count }
        var excess = near + far - max(0, target)
        while excess > 0, let oldest = oldestSegment(isLeading: isLeading) {
            excess -= segments[oldest].count
            segments.remove(at: oldest)
        }
        while excess > 0, let oldest = spacerOrder.firstIndex(where: { $0.trailing != isLeading }) {
            let entry = spacerOrder.remove(at: oldest)
            if isLeading {
                if let height = leading.removeValue(forKey: entry.id) {
                    before = max(0, before - height)
                }
            } else {
                if let height = trailing.removeValue(forKey: entry.id) {
                    after = max(0, after - height)
                }
            }
            excess -= 1
        }
        recomputeTotals()
    }

    /// Segments lying before the resident range, oldest first.
    private func segmentsBefore() -> [SeqSegment] {
        guard let first = residentFirst else { return [] }
        return segments.filter { $0.last < first }.sorted { $0.first < $1.first }
    }

    /// Segments lying after the resident range, oldest first.
    private func segmentsAfter() -> [SeqSegment] {
        guard let last = residentLast else { return segments }
        return segments.filter { $0.first > last }.sorted { $0.first < $1.first }
    }

    private func oldestSegment(isLeading: Bool) -> Int? {
        let side = isLeading ? segmentsBefore() : segmentsAfter()
        guard let first = side.first else { return nil }
        return segments.firstIndex(where: { $0.first == first.first && $0.last == first.last })
    }

    private func trimMeasured() {
        while heights.count > Self.maxMeasured {
            guard let oldest = measureOrder.first else { break }
            measureOrder.removeFirst()
            guard heights[oldest] != nil else { continue }
            // Resident rows remeasure on appear; prefer dropping visitors.
            if resident.contains(oldest), heights.count <= resident.count { break }
            if let old = heights.removeValue(forKey: oldest) {
                measuredTotal -= old
                measuredCount -= 1
            }
        }
    }

    /// Drop the oldest retained spacer IDs past the cap. Dropped space is gone
    /// (never folded into an unbounded total): without sequence bounds it
    /// could never shrink on rehydration.
    private func trimSpacers() {
        while leading.count + trailing.count > Self.maxSpacers, !spacerOrder.isEmpty {
            let oldest = spacerOrder.removeFirst()
            if oldest.trailing {
                if let height = trailing.removeValue(forKey: oldest.id) {
                    after = max(0, after - height)
                }
            } else {
                if let height = leading.removeValue(forKey: oldest.id) {
                    before = max(0, before - height)
                }
            }
        }
        recomputeTotals()
    }
}
