import CoreGraphics
import Foundation
import Testing
@testable import Ace

/// Annotate mode's finger and Pencil on the page (`AnnotateStroke`), and a download saved onto
/// the phone (`SavedFiles`).
@Suite struct BrowserAnnotateTests {
    private func events(_ inputs: [RemoteInput]) -> [String] {
        inputs.compactMap { if case .mouse(let event, _, _, _) = $0 { event } else { nil } }
    }

    @Test func aTapIsOneClickWhereTheFingerTouched() {
        var stroke = AnnotateStroke()
        #expect(stroke.began(view: CGPoint(x: 10, y: 10), page: CGPoint(x: 20, y: 40), fingers: 1).isEmpty)
        // A wobble under the drag distance stays a tap.
        #expect(stroke.moved(view: CGPoint(x: 13, y: 12), page: CGPoint(x: 26, y: 44)).isEmpty)
        let up = stroke.ended()
        #expect(events(up) == ["mouseMoved", "mousePressed", "mouseReleased"])
        #expect(up.allSatisfy { if case .mouse(_, let x, let y, _) = $0 { x == 20 && y == 40 } else { false } })
    }

    @Test func aDragPressesWhereItStartedFollowsTheFingerAndReleasesWhereItEnded() {
        var stroke = AnnotateStroke()
        _ = stroke.began(view: .zero, page: CGPoint(x: 100, y: 100), fingers: 1)
        let start = stroke.moved(view: CGPoint(x: 20, y: 0), page: CGPoint(x: 140, y: 100))
        #expect(events(start) == ["mouseMoved", "mousePressed", "mouseMoved"])
        #expect(events(stroke.moved(view: CGPoint(x: 40, y: 30), page: CGPoint(x: 180, y: 160))) == ["mouseMoved"])
        let end = stroke.ended()
        guard case .mouse("mouseReleased", 180, 160, false)? = end.first else { Issue.record("no release at the end"); return }
    }

    @Test func aSecondFingerBeforeADragSendsNothingSoTwoFingersOnlyScroll() {
        var stroke = AnnotateStroke()
        _ = stroke.began(view: .zero, page: CGPoint(x: 5, y: 5), fingers: 1)
        #expect(stroke.began(view: CGPoint(x: 50, y: 0), page: CGPoint(x: 55, y: 5), fingers: 2).isEmpty)
        #expect(stroke.moved(view: CGPoint(x: 0, y: 80), page: CGPoint(x: 5, y: 85)).isEmpty)
        #expect(stroke.ended().isEmpty)
        // The next touch starts afresh.
        _ = stroke.began(view: .zero, page: CGPoint(x: 1, y: 1), fingers: 1)
        #expect(events(stroke.ended()) == ["mouseMoved", "mousePressed", "mouseReleased"])
    }

    @Test func aSecondFingerDuringADragLetsItGoWhereItIs() {
        var stroke = AnnotateStroke()
        _ = stroke.began(view: .zero, page: .zero, fingers: 1)
        _ = stroke.moved(view: CGPoint(x: 30, y: 0), page: CGPoint(x: 60, y: 0))
        #expect(events(stroke.began(view: CGPoint(x: 90, y: 0), page: .zero, fingers: 2)) == ["mouseReleased"])
        #expect(stroke.ended().isEmpty)
    }

    @Test func aSavedDownloadIsOfferedOnlyOnceWholeAndAnOutOfOrderSliceIsRefused() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("saved-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let files = SavedFiles(root: root, scope: "host-a")
        let bytes = Data((0..<3000).map { UInt8($0 % 251) })
        try files.write(id: "web/dl-1", name: "../report.csv", offset: 0, base64: bytes.prefix(1000).base64EncodedString(), done: false)
        // Part of it is here, but nothing is offered until the last slice.
        #expect(files.file(id: "web/dl-1", name: "../report.csv") == nil)
        #expect(throws: (any Error).self) { try files.write(id: "web/dl-1", name: "../report.csv", offset: 10, base64: "AAAA", done: false) }
        try files.write(id: "web/dl-1", name: "../report.csv", offset: 1000, base64: bytes.dropFirst(1000).base64EncodedString(), done: true)
        let url = try #require(files.file(id: "web/dl-1", name: "../report.csv"))
        #expect(url.lastPathComponent == "report.csv")
        #expect(url.path.hasPrefix(root.path))
        #expect(try Data(contentsOf: url) == bytes)
        // Starting again replaces the copy.
        try files.write(id: "web/dl-1", name: "../report.csv", offset: 0, base64: Data([1, 2]).base64EncodedString(), done: true)
        #expect(try Data(contentsOf: url) == Data([1, 2]))
    }

    @Test func aSaveThatWouldPassTheLimitIsRefusedAndWhatArrivedGoes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("saved-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let files = SavedFiles(root: root, scope: "host-a")
        try files.write(id: "web/big", name: "big.zip", offset: 0, base64: Data([1]).base64EncodedString(), done: false)
        #expect(throws: (any Error).self) {
            try files.write(id: "web/big", name: "big.zip", offset: SavedFiles.maxBytes, base64: Data([2, 3]).base64EncodedString(), done: true)
        }
        #expect((try? FileManager.default.contentsOfDirectory(atPath: root.path))?.isEmpty ?? true)
    }

    @Test func aDiscardedSaveLeavesNothingAndMachinesKeepTheirOwnCopies() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("saved-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let first = SavedFiles(root: root, scope: "host-a"), second = SavedFiles(root: root, scope: "host-b")
        try first.write(id: "web/dl", name: "a.txt", offset: 0, base64: Data([1]).base64EncodedString(), done: true)
        try second.write(id: "web/dl", name: "a.txt", offset: 0, base64: Data([2]).base64EncodedString(), done: true)
        #expect(try Data(contentsOf: try #require(first.file(id: "web/dl", name: "a.txt"))) == Data([1]))
        #expect(try Data(contentsOf: try #require(second.file(id: "web/dl", name: "a.txt"))) == Data([2]))
        try first.write(id: "web/part", name: "b.txt", offset: 0, base64: Data([1]).base64EncodedString(), done: false)
        first.discard(id: "web/part")
        first.discard(id: "web/dl")
        #expect(first.file(id: "web/dl", name: "a.txt") == nil)
        #expect(second.file(id: "web/dl", name: "a.txt") != nil)
    }

    @Test func eachPictureSaysTheTabItsStreamShowsSoAStillIsNeverAnotherTabs() async throws {
        let (description, encoded) = try H264DecodeTests.encode(width: 320, height: 240, frames: 3)
        let shown = TabLog()
        let renderer = BrowserRenderer(threadId: "thread", present: { shown.add($0.tabId) }, ack: { _ in })
        defer { renderer.close() }
        for (index, bytes) in encoded.enumerated() {
            // Only the keyframe names its tab; the deltas after it show the same one.
            renderer.receive(BrowserVideoChunk(threadId: "thread", sequence: index + 1, timestamp: 0, width: 400, height: 300,
                                               codedWidth: 320, codedHeight: 240, codec: "avc1.42E033", key: index == 0,
                                               description: index == 0 ? description : nil, tabId: index == 0 ? "tab-2" : nil, bytes: bytes))
        }
        for _ in 0..<400 where shown.values.count < 3 { try await Task.sleep(for: .milliseconds(5)) }
        #expect(shown.values == ["tab-2", "tab-2", "tab-2"])
    }

    @Test func fileNamesFromTheMachineBecomePlainNamesHere() {
        #expect(SavedFiles.safeName("a/b/.hidden:file") == "hiddenfile")
        #expect(SavedFiles.safeName("") == "download")
        #expect(SavedFiles.safeName("..") == "download")
    }
}

private final class TabLog: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String?] = []
    func add(_ value: String?) { lock.withLock { recorded.append(value) } }
    var values: [String?] { lock.withLock { recorded } }
}
