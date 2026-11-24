import UIKit

/// The flipped transcript's layout (ADR 0222): one column, entry 0 at the live end, every frame
/// from `TranscriptStackGeometry`. The layout owns the scroll offset's only implicit changes:
///
/// - **A height correction** of an entry starting above the viewport's physical top moves the
///   offset by its change, so what is on screen stays still. Entries on screen and past it move
///   nothing.
/// - **A window change** (an older page, newer rows traded for their spacer) keeps the reader's
///   entry where it was on screen (`TranscriptStackGeometry.replace`). An older page extends
///   the far edge and moves nothing.
///
/// Neither stops a fling: UIKit keeps decelerating from the adjusted offset.
@MainActor final class TranscriptCollectionLayout: UICollectionViewLayout {
    /// The flip the collection view and each cell carry: together, upright rows.
    static let upright = CGAffineTransform(scaleX: 1, y: -1)

    private(set) var geometry = TranscriptStackGeometry()
    /// Corrections keep what is on screen still. Off only for the fling probe's
    /// `-ace-fling-no-anchors`, which shows what the scroll does without them.
    var keepsPlace = true
    /// The reader is away from the live end: a row on screen that grows keeps the screen's top
    /// still and grows down past them (`TranscriptStackGeometry.offsetAdjustment`).
    var holdsScreenTop = false
    /// The entries' frames or the content's height changed.
    var changed: (() -> Void)?
    private var pending: (ids: [String], estimate: (String) -> CGFloat?, anchor: String?)?
    private var adjustment: CGFloat = 0

    /// The ids the next layout pass lays out, keeping `anchor` where it is on screen.
    func stage(_ ids: [String], estimate: @escaping (String) -> CGFloat?, anchor: String?) {
        pending = (ids, estimate, anchor)
    }

    /// How far laying out `ids` would move the offset to keep `anchor` where it is on screen,
    /// without laying them out.
    func offsetChange(laying ids: [String], estimate: (String) -> CGFloat?, anchor: String?) -> CGFloat {
        guard keepsPlace else { return 0 }
        var probe = geometry
        return probe.replace(ids, estimate: estimate, keeping: anchor)
    }

    /// The offset change a window change still owes, taken once.
    func takeAdjustment() -> CGFloat {
        defer { adjustment = 0 }
        return keepsPlace ? adjustment : 0
    }

    override func prepare() {
        super.prepare()
        guard let staged = pending else { return }
        pending = nil
        adjustment += geometry.replace(staged.ids, estimate: staged.estimate, keeping: staged.anchor)
        changed?()
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: collectionView?.bounds.width ?? 0, height: geometry.contentHeight)
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        geometry.indices(from: rect.minY, to: rect.maxY).map(attributes(at:))
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard indexPath.section == 0, indexPath.item < geometry.count else { return nil }
        return attributes(at: indexPath.item)
    }

    override func targetContentOffset(forProposedContentOffset proposed: CGPoint) -> CGPoint {
        let owed = takeAdjustment()
        return owed == 0 ? proposed : CGPoint(x: proposed.x, y: proposed.y + owed)
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.width != collectionView?.bounds.width
    }

    override func shouldInvalidateLayout(forPreferredLayoutAttributes preferred: UICollectionViewLayoutAttributes,
                                         withOriginalAttributes original: UICollectionViewLayoutAttributes) -> Bool {
        guard original.indexPath.item < geometry.count else { return false }
        return abs(preferred.size.height - geometry.height(at: original.indexPath.item)) >= 0.5
    }

    override func invalidationContext(forPreferredLayoutAttributes preferred: UICollectionViewLayoutAttributes,
                                      withOriginalAttributes original: UICollectionViewLayoutAttributes)
        -> UICollectionViewLayoutInvalidationContext {
        let context = super.invalidationContext(forPreferredLayoutAttributes: preferred, withOriginalAttributes: original)
        let index = original.indexPath.item
        guard index < geometry.count, let collectionView else { return context }
        let id = geometry.ids[index]
        guard let change = geometry.measure(id, height: preferred.size.height) else { return context }
        if keepsPlace {
            let viewport = collectionView.contentOffset.y
            let held = holdsScreenTop ? viewport + collectionView.bounds.height : viewport
            let move = TranscriptStackGeometry.offsetAdjustment(entryTop: geometry.top(at: index), change: change,
                                                                heldLine: held)
            if move != 0 {
                context.contentOffsetAdjustment = CGPoint(x: 0, y: move)
                PerfCounters.bump("offset.measure")
            }
        }
        context.contentSizeAdjustment = CGSize(width: 0, height: change)
        // The entry and those after it moved; past a few screens they are asked for again as they
        // come into view.
        let bounds = collectionView.bounds
        let reach = geometry.indices(from: geometry.top(at: index), to: bounds.maxY + bounds.height * 3)
        context.invalidateItems(at: reach.map { IndexPath(item: $0, section: 0) })
        changed?()
        return context
    }

    private func attributes(at index: Int) -> UICollectionViewLayoutAttributes {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
        attributes.frame = CGRect(x: 0, y: geometry.top(at: index), width: collectionView?.bounds.width ?? 0,
                                  height: geometry.height(at: index))
        // The collection view is flipped; each cell is flipped back by UIKit as it applies these
        // attributes, so reuse and self-sizing can't drop it.
        attributes.transform = Self.upright
        return attributes
    }
}

/// A transcript cell, sized to fit the column. Its layout attributes flip it back upright
/// (`TranscriptCollectionLayout.upright`); nothing inside it is flipped.
final class TranscriptCell: UICollectionViewCell {
    /// The entry this cell shows now.
    var entryID: String?

    override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes)
        -> UICollectionViewLayoutAttributes {
        let fitted = super.preferredLayoutAttributesFitting(layoutAttributes)
        let size = contentView.systemLayoutSizeFitting(
            CGSize(width: layoutAttributes.size.width, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        fitted.size = CGSize(width: layoutAttributes.size.width, height: ceil(size.height))
        return fitted
    }
}

/// The flipped collection view. VoiceOver reads the cells on screen top to bottom, oldest first,
/// and its three-finger swipes page in the direction they read on screen.
final class TranscriptCollectionView: UICollectionView {
    /// An assistive scroll moved the feed (`accessibilityScroll`).
    var assistiveScrolled: (() -> Void)?

    override var accessibilityElements: [Any]? {
        get { visibleCells.sorted { $0.frame.minY > $1.frame.minY } }
        set {}
    }

    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        let page = bounds.height * 0.8
        let move: CGFloat
        switch direction {
        case .up: move = page
        case .down: move = -page
        default: return false
        }
        let lowest = -adjustedContentInset.top
        let highest = max(lowest, contentSize.height + adjustedContentInset.bottom - bounds.height)
        let target = min(max(contentOffset.y + move, lowest), highest)
        guard target != contentOffset.y else { return false }
        setContentOffset(CGPoint(x: contentOffset.x, y: target), animated: false)
        assistiveScrolled?()
        UIAccessibility.post(notification: .pageScrolled, argument: nil)
        return true
    }
}
