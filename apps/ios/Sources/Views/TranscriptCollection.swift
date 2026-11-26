import SwiftUI
import UIKit

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
    /// The feed follows the live end: a window change may keep the end's entries (the tail, the
    /// composer's room) still. Away from it, the reader's own row is what stays put.
    var followsEnd = true
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
        coordinator.followsEnd = followsEnd
        coordinator.holdsScreenTop(!followsEnd)
        view.accessibilityValue = accessibilityValue
        coordinator.update(entries, estimate: estimate, style: style)
    }

    static func dismantleUIView(_ view: TranscriptCollectionView, coordinator: Coordinator) {
        coordinator.detach()
    }

    @MainActor final class Coordinator: NSObject, UICollectionViewDelegate, UIGestureRecognizerDelegate {
        var events = TranscriptCollectionEvents()
        var environment = EnvironmentValues()
        var followsEnd = true
        private weak var view: TranscriptCollectionView?
        private var layout: TranscriptCollectionLayout?
        private var source: UICollectionViewDiffableDataSource<Int, String>?
        private var entries: [String: TranscriptEntry] = [:]
        private var keys: [String: AnyHashable] = [:]
        private var order: [String] = []
        private var style: AnyHashable?
        private var keyboardUp = false
        private let tap = UITapGestureRecognizer()
        private let touches = TranscriptTouchWatcher(target: nil, action: nil)
        private var sequence = TranscriptScrollSequence()
        private var releaseVelocity: Double?
        private var reported = TranscriptScrollGeometry()
        private var shownRows = Set<String>()
        private var appeared: [String] = []
        private var gone: [String] = []
        private var reportedFrames: [String: CGRect] = [:]
        private var flushQueued = false
        /// A row resized and its frames wait for the offset correction UIKit applies with them.
        private var resizing = false
        private var updating = false
        /// A window change that would move the offset, held while the reader scrolls.
        private var waiting: (entries: [TranscriptEntry], estimate: (String) -> CGFloat?, style: AnyHashable)?

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
            layout.resized = { [weak self] in self?.resizePending() }
            tap.addTarget(self, action: #selector(tapped))
            tap.isEnabled = false
            view.addGestureRecognizer(tap)
            touches.delegate = self
            touches.landed = { [weak self] in self?.touchLanded() }
            touches.lifted = { [weak self] in self?.touchLifted() }
            view.addGestureRecognizer(touches)
            view.assistiveBegan = { [weak self] older, moves in
                guard let self else { return false }
                handle(.assistiveBegan)
                return events.assistivePage(older, moves)
            }
            view.assistiveEnded = { [weak self] in self?.handle(.assistiveEnded) }
            // The surface outlives the collection view (it is the feed's state): weak, or leaving
            // the thread would keep the view and its cells alive.
            surface.attach(view, locate: { [weak layout, weak view] id in
                guard let layout, let view, let index = layout.geometry.position(of: id) else { return nil }
                return CGRect(x: 0, y: layout.geometry.top(at: index), width: view.bounds.width,
                              height: layout.geometry.height(at: index))
            }, aiming: { [weak self] in self?.handle(.animationStarting) },
               animating: { [weak self] in self?.handle(.animationStarted) })
        }

        func detach() {
            view?.delegate = nil
            layout?.changed = nil
            layout?.resized = nil
        }

        func holdsScreenTop(_ holds: Bool) { layout?.holdsScreenTop = holds }

        func setKeyboardUp(_ up: Bool) {
            guard up != keyboardUp else { return }
            keyboardUp = up
            tap.isEnabled = up
            for cell in view?.visibleCells ?? [] { cell.contentView.isUserInteractionEnabled = !up }
        }

        func update(_ next: [TranscriptEntry], estimate: @escaping (String) -> CGFloat?, style: AnyHashable) {
            guard view != nil, let layout, source != nil else { return }
            updating = true
            defer { updating = false; queueFlush() }
            let (ids, byID) = Self.window(next)
            let declared = byID.compactMapValues(\.height)
            let restyled = self.style != nil && self.style != style
            self.style = style
            if ids == order {
                _ = sequence.windowChange(movesOffset: { false })
                waiting = nil
                // A spacer re-estimated in place (Dynamic Type, a layout revision) takes its new
                // height now, wherever it is, not when its cell next sizes itself on screen.
                layout.resize(declared: declared, anchor: { self.anchorEntry(keeping: Set(ids), in: byID) })
                let changed = adopt(byID)
                reconfigure(restyled ? ids.filter { visible($0) } : changed)
                return
            }
            let anchor = anchorEntry(keeping: Set(ids), in: byID)
            // An offset write can't land under a finger or a fling (ADR 0222): a window change
            // that would need one waits for the scroll to come to rest. The rows laid out now
            // still show what they hold now.
            if sequence.windowChange(movesOffset: {
                layout.offsetChange(laying: ids, declared: declared, estimate: estimate, anchor: anchor) != 0
            }) {
                PerfCounters.bump("window.held")
                waiting = (next, estimate, style)
                let changed = refresh(byID)
                reconfigure(restyled ? order.filter { visible($0) } : changed)
                return
            }
            waiting = nil
            lay(ids, byID, declared: declared, estimate: estimate, anchor: anchor, restyled: restyled)
        }

        /// Lays out the window change that waited for the scroll, whatever holds now: the
        /// sequence decided it lands.
        private func land() {
            guard let held = waiting else { return }
            waiting = nil
            updating = true
            defer { updating = false; queueFlush() }
            let (ids, byID) = Self.window(held.entries)
            style = held.style
            lay(ids, byID, declared: byID.compactMapValues(\.height), estimate: held.estimate,
                anchor: anchorEntry(keeping: Set(ids), in: byID), restyled: false)
        }

        /// The ids in order, each once, and the entry for each.
        private static func window(_ next: [TranscriptEntry]) -> (ids: [String], byID: [String: TranscriptEntry]) {
            var ids: [String] = []
            ids.reserveCapacity(next.count)
            var byID: [String: TranscriptEntry] = [:]
            for entry in next where byID[entry.id] == nil {
                ids.append(entry.id)
                byID[entry.id] = entry
            }
            return (ids, byID)
        }

        private func lay(_ ids: [String], _ byID: [String: TranscriptEntry], declared: [String: CGFloat],
                         estimate: @escaping (String) -> CGFloat?, anchor: String?, restyled: Bool) {
            guard let view, let layout, let source else { return }
            let changed = adopt(byID)
            layout.stage(ids, declared: declared, estimate: estimate, anchor: anchor)
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

        /// Takes `byID` as the whole window. Returns the ids already here whose key changed.
        private func adopt(_ byID: [String: TranscriptEntry]) -> [String] {
            let changed = byID.compactMap { id, entry in keys[id].flatMap { $0 != entry.key ? id : nil } }
            entries = byID
            keys = byID.mapValues(\.key)
            return changed
        }

        /// Takes `byID`'s entries for the ids laid out now, while a window change waits. Returns
        /// those whose key changed.
        private func refresh(_ byID: [String: TranscriptEntry]) -> [String] {
            var changed: [String] = []
            for id in order {
                guard let entry = byID[id] else { continue }
                if keys[id] != entry.key { changed.append(id) }
                entries[id] = entry
                keys[id] = entry.key
            }
            return changed
        }

        private func reconfigure(_ ids: [String]) {
            guard let source, !ids.isEmpty else { return }
            var snapshot = source.snapshot()
            snapshot.reconfigureItems(ids)
            source.apply(snapshot, animatingDifferences: false)
        }

        /// The entry on screen still laid out after the change: the reader's
        /// (`TranscriptStackGeometry.readerAnchor`). Away from the end, the first row on screen: a
        /// reader just short of the end, with the composer's room still in view, keeps their rows
        /// still as a new row lands under them.
        private func anchorEntry(keeping ids: Set<String>, in next: [String: TranscriptEntry]) -> String? {
            guard let view, let layout else { return nil }
            let entries = entries
            return layout.geometry.readerAnchor(
                from: view.contentOffset.y, to: view.contentOffset.y + view.bounds.height, keeping: ids,
                followsEnd: followsEnd, isRow: { (next[$0] ?? entries[$0])?.isRow == true },
                isBlank: { (next[$0] ?? entries[$0])?.height != nil })
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
            if updating { flushSoon() } else { flush() }
        }

        private func flushSoon() {
            guard !flushQueued else { return }
            flushQueued = true
            DispatchQueue.main.async { [weak self] in
                self?.flushQueued = false
                self?.flush()
            }
        }

        /// A row measured to a new height: its frames go out once UIKit has applied the offset
        /// correction that comes with them (`scrollViewDidScroll`), or on the next turn of the
        /// run loop when there was none. Reported now, against the old offset, they would show
        /// the reader's row moved and the feed would correct it a second time.
        private func resizePending() {
            resizing = true
            flushSoon()
        }

        private func flush() {
            guard let view, let layout else { return }
            resizing = false
            for id in gone { events.rowGone(id) }
            gone.removeAll()
            for id in appeared { events.rowAppeared(id) }
            appeared.removeAll()
            let geometry = layout.geometry
            var laidOut: [(id: String, frame: CGRect)] = []
            for id in shownRows {
                guard let index = geometry.position(of: id) else { continue }
                let frame = CGRect(x: 0, y: geometry.top(at: index), width: view.bounds.width, height: geometry.height(at: index))
                guard reportedFrames[id] != frame else { continue }
                reportedFrames[id] = frame
                laidOut.append((id, frame))
            }
            if laidOut.isEmpty {
                reportGeometry()
            } else {
                events.rowsLaidOut(laidOut, takeGeometry())
            }
        }

        private func reportGeometry() {
            guard let (old, now) = takeGeometry() else { return }
            events.geometry(old, now)
        }

        /// The scroll geometry since the last report, when it changed.
        private func takeGeometry() -> (old: TranscriptScrollGeometry, new: TranscriptScrollGeometry)? {
            guard let view else { return nil }
            let now = TranscriptScrollGeometry(offset: view.contentOffset.y,
                                               contentHeight: layout?.geometry.contentHeight ?? view.contentSize.height,
                                               viewport: view.bounds.height)
            guard now != reported else { return nil }
            let old = reported
            reported = now
            return (old, now)
        }

        // MARK: Phases

        /// Hands `event` to the sequence and does what it decides, in its order: a held window
        /// change lands and its geometry goes out before the feed hears the phase it lands for.
        private func handle(_ event: TranscriptScrollSequence.Event) {
            for action in sequence.handle(event) {
                switch action {
                case .land: land()
                case .report: flush()
                case .phase(let old, let next):
                    let velocity = next == .decelerating ? releaseVelocity : nil
                    if next == .idle || next == .interacting { releaseVelocity = nil }
                    events.phase(old, next, reported, velocity)
                case .checkAnimation(let which):
                    DispatchQueue.main.asyncAfter(deadline: .now() + TranscriptPlaceKeeper.animationLimit / 1000) { [weak self] in
                        self?.handle(.animationOverdue(which))
                    }
                }
            }
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            if updating { flushSoon() } else if resizing { flush() } else { reportGeometry() }
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { handle(.dragBegan) }

        /// The finger lifted: UIKit's own release velocity, in points per second toward older rows.
        func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint,
                                       targetContentOffset: UnsafeMutablePointer<CGPoint>) {
            releaseVelocity = Double(velocity.y) * 1000
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            handle(.dragEnded(decelerates: decelerate))
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { handle(.decelerationEnded) }

        func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { handle(.animationEnded) }

        func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
            handle(.animationStarting)
            handle(.animationStarted)
            return true
        }

        func scrollViewDidScrollToTop(_ scrollView: UIScrollView) { handle(.animationEnded) }

        /// A finger came down: the reader holds the feed from here, before any drag begins, so
        /// nothing replaces the rows under it.
        private func touchLanded() { handle(.touchDown) }

        /// A touch that lifted without dragging, or stopped a fling and lifted, ends no UIKit
        /// callback.
        private func touchLifted() {
            guard let view else { return }
            handle(.touchUp(scrolling: view.isDecelerating || view.isDragging))
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
