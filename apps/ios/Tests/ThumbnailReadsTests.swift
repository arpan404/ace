import Testing
import UIKit
@testable import Ace

@MainActor @Suite struct ThumbnailReadsTests {
    /// A host read that answers only when the test lets it, counting how often it was asked.
    @MainActor final class Host {
        var asked = 0
        var kept: [String: UIImage] = [:]
        private var waiting: [CheckedContinuation<Void, Never>] = []
        let image = UIImage()

        func start(_ key: String) -> @MainActor () async -> UIImage? {
            { [self] in
                asked += 1
                await withCheckedContinuation { waiting.append($0) }
                kept[key] = image
                return image
            }
        }

        func answer() {
            for continuation in waiting { continuation.resume() }
            waiting.removeAll()
        }
    }

    /// Lets the tasks started so far run up to their next wait.
    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    @Test func twoTilesShowingOnePreviewReadItOnce() async {
        let reads = ThumbnailReads(), host = Host()
        let first = Task { await reads.read("a", kept: { host.kept["a"] }, start: host.start("a")) }
        let second = Task { await reads.read("a", kept: { host.kept["a"] }, start: host.start("a")) }
        await settle()
        host.answer()

        #expect(await first.value === host.image)
        #expect(await second.value === host.image)
        #expect(host.asked == 1)
        #expect(reads.count == 0)
    }

    @Test func aTileFlungAwayMidReadLeavesTheReadRunningForTheNextTile() async {
        let reads = ThumbnailReads(), host = Host()
        let gone = Task { await reads.read("a", kept: { host.kept["a"] }, start: host.start("a")) }
        await settle()
        // The cell is recycled during a fling: SwiftUI cancels its task.
        gone.cancel()
        let back = Task { await reads.read("a", kept: { host.kept["a"] }, start: host.start("a")) }
        await settle()
        host.answer()

        #expect(await back.value === host.image)
        #expect(host.asked == 1)
        // Later tiles draw it from what was kept, asking nothing.
        #expect(await reads.read("a", kept: { host.kept["a"] }, start: host.start("a")) === host.image)
        #expect(host.asked == 1)
    }
}
