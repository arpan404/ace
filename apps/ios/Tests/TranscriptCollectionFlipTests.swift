import Testing
import UIKit
@testable import Ace

/// The transcript draws upright: the collection view is flipped so the live end sits at the
/// bottom, and each cell UIKit lays out is flipped back, once.
@MainActor @Suite struct TranscriptCollectionFlipTests {
    @Test func aLaidOutRowDrawsUprightInsideTheFlippedTranscript() throws {
        let (view, layout) = TranscriptCollection.makeCollection()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 800))
        view.frame = window.bounds
        window.addSubview(view)
        window.isHidden = false
        let registration = UICollectionView.CellRegistration<TranscriptCell, String> { cell, _, id in
            var content = UIListContentConfiguration.cell()
            content.text = id
            cell.contentConfiguration = content
        }
        let source = UICollectionViewDiffableDataSource<Int, String>(collectionView: view) { view, path, id in
            view.dequeueConfiguredReusableCell(using: registration, for: path, item: id)
        }
        layout.stage(["tail", "Step 120", "Step 119"], estimate: { _ in 80 }, anchor: nil)
        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(["tail", "Step 120", "Step 119"])
        source.apply(snapshot, animatingDifferences: false)
        view.layoutIfNeeded()

        let cell = try #require(view.cellForItem(at: IndexPath(item: 1, section: 0)))
        #expect(view.transform.d == -1)
        #expect(cell.transform.d == -1)
        #expect(cell.contentView.transform.isIdentity)
        #expect(view.transform.concatenating(cell.transform).d == 1)
        // Reused for another row, it stays flipped back.
        snapshot.deleteItems(["Step 120"])
        source.apply(snapshot, animatingDifferences: false)
        view.layoutIfNeeded()
        for visible in view.visibleCells { #expect(visible.transform.d == -1) }
        window.isHidden = true
    }
}
