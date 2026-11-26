import Testing
import UIKit
@testable import Ace

@MainActor @Suite struct ThumbnailReadsTests {
    /// A host read that answers only when the test lets it, counting how often it was asked. Like
    /// the real service, a read whose task is cancelled before the answer gives nothing and keeps
    /// nothing.
    @MainActor final class Host {
        var asked = 0
        var kept: [String: UIImage] = [:]
        private var answers: [CheckedContinuation<Void, Never>] = []
        private var starts: [CheckedContinuation<Void, Never>] = []

        func start(_ key: String, image: UIImage) -> @MainActor () async -> UIImage? {
            { [self] in
                asked += 1
                for start in starts { start.resume() }
                starts.removeAll()
                await withCheckedContinuation { answers.append($0) }
                if Task.isCancelled { return nil }
                kept[key] = image
                return image
            }
        }

        /// Returns once a read has started.
        func started() async {
            if asked > 0 { return }
            await withCheckedContinuation { starts.append($0) }
        }

        func answer() {
            for answer in answers { answer.resume() }
            answers.removeAll()
        }
    }

    @Test func twoTilesShowingOnePreviewReadItOnce() async {
        let reads = ThumbnailReads(), host = Host(), image = UIImage()
        let first = Task { await reads.read("a", kept: { host.kept["a"] }, start: host.start("a", image: image)) }
        await host.started()
        let second = Task { await reads.read("a", kept: { host.kept["a"] }, start: host.start("a", image: image)) }
        await Task.yield()
        host.answer()

        #expect(await first.value === image)
        #expect(await second.value === image)
        #expect(host.asked == 1)
        #expect(reads.count == 0)
    }

    @Test func aTileFlungAwayMidReadLeavesTheReadRunningForTheNextTile() async {
        let reads = ThumbnailReads(), host = Host(), image = UIImage(), other = UIImage()
        let gone = Task { await reads.read("a", kept: { host.kept["a"] }, start: host.start("a", image: image)) }
        await host.started()
        // The cell is recycled during a fling: SwiftUI cancels its task while the read waits.
        gone.cancel()
        let back = Task { await reads.read("a", kept: { host.kept["a"] }, start: host.start("a", image: other)) }
        await Task.yield()
        host.answer()

        // The returning tile gets the first read's preview: the cancellation never reached it.
        #expect(await back.value === image)
        #expect(host.kept["a"] === image)
        #expect(host.asked == 1)
    }
}
