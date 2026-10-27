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

    @Test func aSavedDownloadIsWrittenSliceBySliceAndAnOutOfOrderSliceIsRefused() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("saved-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let files = SavedFiles(root: root)
        let bytes = Data((0..<3000).map { UInt8($0 % 251) })
        try files.write(id: "dl-1", name: "../report.csv", offset: 0, base64: bytes.prefix(1000).base64EncodedString())
        try files.write(id: "dl-1", name: "../report.csv", offset: 1000, base64: bytes.dropFirst(1000).base64EncodedString())
        let url = try #require(files.file(id: "dl-1", name: "../report.csv"))
        #expect(url.lastPathComponent == "report.csv")
        #expect(url.path.hasPrefix(root.path))
        #expect(try Data(contentsOf: url) == bytes)
        #expect(throws: (any Error).self) { try files.write(id: "dl-1", name: "../report.csv", offset: 10, base64: "AAAA") }
        // Starting again replaces the copy.
        try files.write(id: "dl-1", name: "../report.csv", offset: 0, base64: Data([1, 2]).base64EncodedString())
        #expect(try Data(contentsOf: url) == Data([1, 2]))
    }

    @Test func fileNamesFromTheMachineBecomePlainNamesHere() {
        #expect(SavedFiles.safeName("a/b/.hidden:file") == "hiddenfile")
        #expect(SavedFiles.safeName("") == "download")
        #expect(SavedFiles.safeName("..") == "download")
    }
}
