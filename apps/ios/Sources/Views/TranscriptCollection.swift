import SwiftUI
import UIKit

/// One entry of the transcript: a row, the tail, a spacer. `key` changes when what it shows
/// changes; an entry whose key holds is never configured again, so a fling re-evaluates only
/// the rows coming on screen.
struct TranscriptEntry {
    let id: String
    let key: AnyHashable
    /// A transcript row: the feed hears where it lays out, and when it comes and goes.
    var isRow = false
    let content: () -> AnyView
}

/// What the scroll view is doing, as SwiftUI's `ScrollPhase` names it.
enum TranscriptScrollPhase: Sendable {
    case idle, tracking, interacting, decelerating, animating
}

/// The scroll view's geometry in its own (physical) coordinates.
struct TranscriptScrollGeometry: Equatable, Sendable {
    var offset: CGFloat = 0
    var contentHeight: CGFloat = 0
    var viewport: CGFloat = 0
}

/// What the feed hears from the collection. Set on each update, so the closures see the feed's
/// latest values.
struct TranscriptCollectionEvents {
    var phase: (_ old: TranscriptScrollPhase, _ new: TranscriptScrollPhase, _ geometry: TranscriptScrollGeometry,
                _ releaseVelocity: Double?) -> Void = { _, _, _, _ in }
    var geometry: (_ old: TranscriptScrollGeometry, _ new: TranscriptScrollGeometry) -> Void = { _, _ in }
    var rowLaidOut: (_ id: String, _ frame: CGRect) -> Void = { _, _ in }
    var rowAppeared: (_ id: String) -> Void = { _ in }
    var rowGone: (_ id: String) -> Void = { _ in }
    /// A window change moved the offset to keep the reader's entry on screen.
    var placeKept: (_ by: CGFloat) -> Void = { _ in }
}

/// The transcript's scroll view (ADR 0222): a flipped `UICollectionView` whose cells host the
/// SwiftUI rows. The layout owns every implicit offset change (`TranscriptCollectionLayout`);
/// the feed moves it only through `TranscriptSurface`.
struct TranscriptCollection: UIViewRepresentable {
    let entries: [TranscriptEntry]
    let surface: TranscriptSurface
    let events: TranscriptCollectionEvents
    /// The size estimate for an entry never measured.
    let estimate: (String) -> CGFloat?
    /// Changes when every visible entry must be configured again (type size, density).
    let style: AnyHashable
    /// The keyboard is up: a tap on the conversation only puts it away.
    let keyboardUp: Bool
    let accessibilityValue: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> TranscriptCollectionView {
        let (view, layout) = Self.makeCollection()
        context.coordinator.attach(view, layout: layout, surface: surface)
        return view
    }

    /// The flipped collection view and its layout, before the feed attaches.
    static func makeCollection() -> (TranscriptCollectionView, TranscriptCollectionLayout) {
        let layout = TranscriptCollectionLayout()
        layout.keepsPlace = !TranscriptFlingProbe.suppressesAnchors
        let view = TranscriptCollectionView(frame: .zero, collectionViewLayout: layout)
        view.transform = TranscriptCollectionLayout.upright
        view.backgroundColor = .clear
        view.contentInsetAdjustmentBehavior = .never
        view.keyboardDismissMode = .interactive
        view.alwaysBounceVertical = true
        view.selfSizingInvalidation = .enabledIncludingConstraints
        view.accessibilityIdentifier = "transcript"
        // An edge effect tied to a physical edge would draw at the opposite end of the flipped feed;
        // the navigation bar paints its own background.
        if #available(iOS 26, *) {
            view.topEdgeEffect.isHidden = true
            view.bottomEdgeEffect.isHidden = true
        }
        return (view, layout)
    }

    func updateUIView(_ view: TranscriptCollectionView, context: Context) {
        let coordinator = context.coordinator
        coordinator.events = events
        coordinator.environment = context.environment
        coordinator.setKeyboardUp(keyboardUp)
        view.accessibilityValue = accessibilityValue
        coordinator.update(entries, estimate: estimate, style: style)
    }

    static func dismantleUIView(_ view: TranscriptCollectionView, coordinator: Coordinator) {
        coordinator.detach()
    }

    @MainActor final class Coordinator: NSObject, UICollectionViewDelegate, UIGestureRecognizerDelegate {
        var events = TranscriptCollectionEvents()
        var environment = EnvironmentValues()
        private weak var view: TranscriptCollectionView?
        private var layout: TranscriptCollectionLayout?
        private var source: UICollectionViewDiffableDataSource<Int, String>?
        private var entries: [String: TranscriptEntry] = [:]
        private var keys: [String: AnyHashable] = [:]
        private var order: [String] = []
        private var style: AnyHashable?
        private var keyboardUp = false
        private let tap = UITapGestureRecognizer()
        private let touches = TouchWatcher(target: nil, action: nil)
        private var phase = TranscriptScrollPhase.idle
        private var releaseVelocity: Double?
        private var reported = TranscriptScrollGeometry()
        private var shownRows = Set<String>()
        private var appeared: [String] = []
        private var gone: [String] = []
        private var reportedFrames: [String: CGRect] = [:]
        private var flushQueued = false
        private var updating = false

        func attach(_ view: TranscriptCollectionView, layout: TranscriptCollectionLayout, surface: TranscriptSurface) {
            self.view = view
            self.layout = layout
            view.delegate = self
            let registration = UICollectionView.CellRegistration<TranscriptCell, String> { [weak self] cell, _, id in
                self?.configure(cell, id: id)
            }
            source = UICollectionViewDiffableDataSource(collectionView: view) { view, path, id in
                view.dequeueConfiguredReusableCell(using: registration, for: path, item: id)
            }
            layout.changed = { [weak self] in self?.queueFlush() }
            tap.addTarget(self, action: #selector(tapped))
            tap.isEnabled = false
            view.addGestureRecognizer(tap)
            touches.delegate = self
            touches.lifted = { [weak self] in self?.touchLifted() }
            view.addGestureRecognizer(touches)
            view.assistiveScrolled = { [weak self] in
                self?.move(to: .animating)
                self?.move(to: .idle)
            }
            surface.attach(view, locate: { [weak layout] id in
                guard let layout, let index = layout.geometry.position(of: id) else { return nil }
                return CGRect(x: 0, y: layout.geometry.top(at: index), width: view.bounds.width,
                              height: layout.geometry.height(at: index))
            }, animating: { [weak self] in self?.move(to: .animating) })
        }

        func detach() {
            view?.delegate = nil
            layout?.changed = nil
        }

        func setKeyboardUp(_ up: Bool) {
            guard up != keyboardUp else { return }
            keyboardUp = up
            tap.isEnabled = up
            for cell in view?.visibleCells ?? [] { cell.contentView.isUserInteractionEnabled = !up }
        }

        func update(_ next: [TranscriptEntry], estimate: @escaping (String) -> CGFloat?, style: AnyHashable) {
            guard let view, let layout, let source else { return }
            updating = true
            defer { updating = false; queueFlush() }
            var ids: [String] = []
            ids.reserveCapacity(next.count)
            var changed: [String] = []
            var byID: [String: TranscriptEntry] = [:]
            for entry in next where byID[entry.id] == nil {
                ids.append(entry.id)
                byID[entry.id] = entry
                if let key = keys[entry.id], key != entry.key { changed.append(entry.id) }
            }
            entries = byID
            keys = byID.mapValues(\.key)
            let restyled = self.style != nil && self.style != style
            self.style = style
            if ids == order {
                if restyled { changed = ids.filter { visible($0) } }
                guard !changed.isEmpty else { return }
                var snapshot = source.snapshot()
                snapshot.reconfigureItems(changed)
                source.apply(snapshot, animatingDifferences: false)
                return
            }
            let anchor = anchorEntry(keeping: Set(ids))
            layout.stage(ids, estimate: estimate, anchor: anchor)
            order = ids
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(ids)
            let kept = restyled ? ids.filter { visible($0) } : changed.filter { source.snapshot().indexOfItem($0) != nil }
            if !kept.isEmpty { snapshot.reconfigureItems(kept) }
            source.apply(snapshot, animatingDifferences: false)
            view.layoutIfNeeded()
            let owed = layout.takeAdjustment()
            if owed != 0 {
                PerfCounters.bump("offset.join")
                view.contentOffset.y += owed
                events.placeKept(owed)
            }
        }

        /// The entry at the viewport's physical top still laid out after the change: the reader's.
        private func anchorEntry(keeping ids: Set<String>) -> String? {
            guard let view, let layout else { return nil }
            let geometry = layout.geometry
            let range = geometry.indices(from: view.contentOffset.y, to: view.contentOffset.y + view.bounds.height)
            return range.lazy.map { geometry.ids[$0] }.first { ids.contains($0) }
        }

        private func visible(_ id: String) -> Bool {
            guard let view, let path = source?.indexPath(for: id) else { return false }
            return view.indexPathsForVisibleItems.contains(path)
        }

        private func configure(_ cell: TranscriptCell, id: String) {
            guard let entry = entries[id] else { return }
            if entry.isRow { PerfCounters.bump("row.configure") }
            cell.entryID = id
            let environment = environment
            cell.contentConfiguration = UIHostingConfiguration {
                entry.content().environment(\.self, environment)
            }
            .margins(.all, 0)
            .minSize(width: 0, height: 0)
            cell.contentView.isUserInteractionEnabled = !keyboardUp
        }

        // MARK: Rows coming and going

        func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell,
                            forItemAt indexPath: IndexPath) {
            guard let id = (cell as? TranscriptCell)?.entryID, entries[id]?.isRow == true else { return }
            cell.contentView.isUserInteractionEnabled = !keyboardUp
            if shownRows.insert(id).inserted { appeared.append(id) }
            queueFlush()
        }

        func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell,
                            forItemAt indexPath: IndexPath) {
            guard let id = (cell as? TranscriptCell)?.entryID, shownRows.contains(id) else { return }
            // The cell for a row still on screen can end displaying as a batch update moves it.
            if let path = source?.indexPath(for: id), collectionView.indexPathsForVisibleItems.contains(path) { return }
            shownRows.remove(id)
            reportedFrames[id] = nil
            gone.append(id)
            queueFlush()
        }

        /// Reports what changed since the last report, outside any SwiftUI update.
        private func queueFlush() {
            if updating {
                guard !flushQueued else { return }
                flushQueued = true
                DispatchQueue.main.async { [weak self] in
                    self?.flushQueued = false
                    self?.flush()
                }
                return
            }
            flush()
        }

        private func flush() {
            guard let view, let layout else { return }
            for id in gone { events.rowGone(id) }
            gone.removeAll()
            for id in appeared { events.rowAppeared(id) }
            appeared.removeAll()
            let geometry = layout.geometry
            for id in shownRows {
                guard let index = geometry.position(of: id) else { continue }
                let frame = CGRect(x: 0, y: geometry.top(at: index), width: view.bounds.width, height: geometry.height(at: index))
                guard reportedFrames[id] != frame else { continue }
                reportedFrames[id] = frame
                events.rowLaidOut(id, frame)
            }
            reportGeometry()
        }

        private func reportGeometry() {
            guard let view else { return }
            let now = TranscriptScrollGeometry(offset: view.contentOffset.y,
                                               contentHeight: layout?.geometry.contentHeight ?? view.contentSize.height,
                                               viewport: view.bounds.height)
            guard now != reported else { return }
            let old = reported
            reported = now
            events.geometry(old, now)
        }

        // MARK: Phases

        private func move(to next: TranscriptScrollPhase) {
            guard next != phase else { return }
            let old = phase
            phase = next
            let velocity = next == .decelerating ? releaseVelocity : nil
            if next == .idle || next == .interacting { releaseVelocity = nil }
            events.phase(old, next, reported, velocity)
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            if updating { queueFlush() } else { reportGeometry() }
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { move(to: .interacting) }

        /// The finger lifted: UIKit's own release velocity, in points per second toward older rows.
        func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint,
                                       targetContentOffset: UnsafeMutablePointer<CGPoint>) {
            releaseVelocity = Double(velocity.y) * 1000
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            move(to: decelerate ? .decelerating : .idle)
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { move(to: .idle) }

        func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { move(to: .idle) }

        func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
            move(to: .animating)
            return true
        }

        func scrollViewDidScrollToTop(_ scrollView: UIScrollView) { move(to: .idle) }

        /// A touch that stopped a fling and lifted without dragging ends no UIKit callback.
        private func touchLifted() {
            guard let view, phase == .decelerating, !view.isDecelerating, !view.isDragging else { return }
            move(to: .idle)
        }

        @objc private func tapped() {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            gestureRecognizer === touches
        }
    }
}

/// Hears every touch on the transcript without taking it.
private final class TouchWatcher: UIGestureRecognizer {
    var lifted: (() -> Void)?

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        lifted?()
        state = .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        lifted?()
        state = .failed
    }
}
