import XCTest
import ApplicationServices
import CoreGraphics
@testable import ScreenHelper

final class ComputerRequestLineTests: XCTestCase {
    func testLinesSplitAcrossReadsAreJoined() {
        var framer = CULineFramer(limit: 1_000)
        XCTAssertEqual(framer.feed(Array("{\"id\":\"a\",".utf8)), [])
        XCTAssertEqual(framer.feed(Array("\"op\":\"hello\"}\n{\"id\"".utf8)), [.line(Data("{\"id\":\"a\",\"op\":\"hello\"}".utf8))])
        XCTAssertEqual(framer.feed(Array(":\"b\"}\n".utf8)), [.line(Data("{\"id\":\"b\"}".utf8))])
    }

    func testOverLongLineIsDiscardedAndTheNextRequestStillArrives() {
        var framer = CULineFramer(limit: 64)
        let long = "{\"id\":\"big\",\"op\":\"act\",\"text\":\"" + String(repeating: "x", count: 500) + "\"}\n"
        let lines = framer.feed(Array((long + "{\"id\":\"next\",\"op\":\"hello\"}\n").utf8))
        XCTAssertEqual(lines.count, 2)
        guard case .overlong(let prefix) = lines[0] else { return XCTFail("expected an over-long line") }
        XCTAssertLessThanOrEqual(prefix.count, 4_096)
        guard case .invalid(let id, _) = cuParseRequestLine(lines[0]) else { return XCTFail("expected bad_request") }
        XCTAssertEqual(id, "big")
        guard case .request(let next, _) = cuParseRequestLine(lines[1]) else { return XCTFail("expected a request") }
        XCTAssertEqual(next, "next")
    }

    func testBadJsonRepliesToTheIdItCanFindOrToAnEmptyId() {
        guard case .invalid(let found, _) = cuParseRequestLine(.line(Data("{\"id\": \"r7\", \"op\": oops}".utf8))) else { return XCTFail() }
        XCTAssertEqual(found, "r7")
        guard case .invalid(let none, _) = cuParseRequestLine(.line(Data("not json".utf8))) else { return XCTFail() }
        XCTAssertEqual(none, "")
        guard case .invalid(let missing, _) = cuParseRequestLine(.line(Data("{\"op\":\"hello\"}".utf8))) else { return XCTFail() }
        XCTAssertEqual(missing, "")
        guard case .invalid(let noOp, _) = cuParseRequestLine(.line(Data("{\"id\":\"q\"}".utf8))) else { return XCTFail() }
        XCTAssertEqual(noOp, "q")
    }

    func testBlankLinesAreIgnored() {
        guard case .blank = cuParseRequestLine(.line(Data("  \r".utf8))) else { return XCTFail("expected blank") }
    }
}

final class ComputerCancellationTests: XCTestCase {
    func testCancellingAnInFlightRequestStopsItAndUnknownIdsReportFalse() {
        let registry = CUCancellations()
        registry.register("a")
        XCTAssertFalse(registry.isCancelled("a"))
        XCTAssertTrue(registry.cancel("a"))
        XCTAssertTrue(registry.isCancelled("a"))
        XCTAssertFalse(registry.cancel("nope"))
        registry.finish("a")
        XCTAssertFalse(registry.cancel("a"))
    }

    func testCancelledRequestsFailTheGuardWithCancelled() {
        let facts = CUGuardFacts(locked: false, appFrontmost: false, secondsSinceHumanInput: 60, stopRequested: false, cancelled: true)
        XCTAssertThrowsError(try cuGuard(facts, app: "Notes")) { XCTAssertEqual(($0 as? CUError)?.code, "cancelled") }
    }

    func testEscapeStopsOnlyTheBatchItWasPressedDuring() {
        let signal = CUStopSignal()
        signal.escapePressed()
        signal.begin()
        XCTAssertFalse(signal.stopRequested, "an Esc before the batch must not stop it")
        signal.escapePressed()
        XCTAssertTrue(signal.stopRequested)
        signal.end()
        signal.begin()
        XCTAssertFalse(signal.stopRequested, "the next batch starts clean")
    }

    func testSystemFactsAreReadAtMostOncePerInterval() {
        var throttle = CUThrottle(intervalNs: 100)
        XCTAssertTrue(throttle.due(now: 1_000))
        XCTAssertFalse(throttle.due(now: 1_050))
        XCTAssertTrue(throttle.due(now: 1_100))
    }
}

final class ComputerWindowTests: XCTestCase {
    func testWindowNumbersSurviveReorderingAndNewWindowsTakeTheLowestFreeNumber() {
        var numbering = CUWindowNumbering<Int>()
        XCTAssertEqual(numbering.assign([10, 20]), [1, 2])
        XCTAssertEqual(numbering.assign([20, 10]), [2, 1], "front-to-back order changes must not renumber")
        XCTAssertEqual(numbering.assign([20, 30]), [2, 1], "a closed window's number goes to the next new one")
        XCTAssertEqual(numbering.assign([40, 20, 30]), [3, 2, 1])
    }

    func testOtherSpaceSearchStopsAfterALongRunWithoutWindowsOnlyOnceSomeWereFound() {
        XCTAssertFalse(cuRemoteScanIsPastWindows(lastFound: nil, next: 150_000), "keeps looking until the first window")
        XCTAssertFalse(cuRemoteScanIsPastWindows(lastFound: 522, next: 2_000))
        XCTAssertTrue(cuRemoteScanIsPastWindows(lastFound: 522, next: 3_000))
        XCTAssertFalse(cuRemoteScanIsPastWindows(lastFound: 40_000, next: 150_000), "late windows widen the search")
    }

    func testKeysGoToADialogOrNewerWindowOverTheChosenOne() {
        XCTAssertEqual(cuKeyWindowTarget(CUKeyWindowFacts(chosen: 50, focused: 20, focusedSubrole: "AXDialog", focusedRole: "AXWindow")), 20)
        XCTAssertEqual(cuKeyWindowTarget(CUKeyWindowFacts(chosen: 50, focused: 70, focusedSubrole: "AXStandardWindow", focusedRole: "AXWindow")), 70)
        XCTAssertEqual(cuKeyWindowTarget(CUKeyWindowFacts(chosen: 50, focused: 20, focusedSubrole: "AXStandardWindow", focusedRole: "AXWindow")), 50)
        XCTAssertEqual(cuKeyWindowTarget(CUKeyWindowFacts(chosen: 50, focused: nil, focusedSubrole: nil, focusedRole: nil)), 50)
    }

    func testPixelsMapIntoTheWindowsCurrentFrameEvenAfterItMoves() throws {
        let shot = CUShotGeometry(window: 7, size: CGSize(width: 800, height: 600), scale: 1.5)
        let point = try cuMapPixel(CGPoint(x: 150, y: 300), shot: shot, window: 7, frame: CGRect(x: 100, y: 50, width: 800, height: 600))
        XCTAssertEqual(point, CGPoint(x: 200, y: 250))
        let moved = try cuMapPixel(CGPoint(x: 150, y: 300), shot: shot, window: 7, frame: CGRect(x: 400, y: 50, width: 800, height: 600))
        XCTAssertEqual(moved, CGPoint(x: 500, y: 250))
    }

    func testPixelsFromAStaleScreenshotAreRefused() {
        let shot = CUShotGeometry(window: 7, size: CGSize(width: 800, height: 600), scale: 2)
        let frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        for (shot, window, frame) in [(shot, UInt32(8), frame), (shot, 7, CGRect(x: 0, y: 0, width: 900, height: 600)), (nil, 7, frame)] as [(CUShotGeometry?, UInt32, CGRect)] {
            XCTAssertThrowsError(try cuMapPixel(CGPoint(x: 10, y: 10), shot: shot, window: window, frame: frame)) {
                XCTAssertEqual(($0 as? CUError)?.code, "no_screenshot")
            }
        }
        XCTAssertThrowsError(try cuMapPixel(CGPoint(x: 1_700, y: 10), shot: shot, window: 7, frame: frame)) {
            XCTAssertEqual(($0 as? CUError)?.code, "outside_window")
        }
    }
}

@MainActor final class ComputerElementIdTests: XCTestCase {
    // Application elements for different pids are distinct AX elements without any permission.
    private let rowView = AXUIElementCreateApplication(90_001)
    private let button = AXUIElementCreateApplication(90_002)

    func testARecycledRowShowingOtherContentGetsANewIdAndTheOldIdGoesStale() {
        let registry = CUElementRegistry()
        let first = registry.id(for: rowView, fingerprint: "AXRow|3|")
        XCTAssertEqual(registry.id(for: rowView, fingerprint: "AXRow|3|"), first)
        let reused = registry.id(for: rowView, fingerprint: "AXRow|9|")
        XCTAssertNotEqual(reused, first)
        XCTAssertNil(registry.element(first), "a click on the old id must fail as stale, not hit the new row")
        XCTAssertNotNil(registry.element(reused))
    }

    func testElementsOutsideListsKeepTheirIdWhateverTheyShow() {
        let registry = CUElementRegistry()
        let id = registry.id(for: button)
        XCTAssertEqual(registry.id(for: button), id)
        XCTAssertEqual(registry.existingId(for: button), id)
    }
}

final class ComputerClippingTests: XCTestCase {
    private let visible = CGRect(x: 0, y: 100, width: 400, height: 300)

    func testElementsScrolledOutOfViewAreClassifiedAboveBelowOrBeside() {
        XCTAssertEqual(cuVisibility(of: CGRect(x: 0, y: 20, width: 100, height: 50), in: visible), .above)
        XCTAssertEqual(cuVisibility(of: CGRect(x: 0, y: 420, width: 100, height: 50), in: visible), .below)
        XCTAssertEqual(cuVisibility(of: CGRect(x: 500, y: 200, width: 100, height: 50), in: visible), .beside)
        XCTAssertEqual(cuVisibility(of: CGRect(x: 0, y: 380, width: 100, height: 50), in: visible), .visible, "partly visible counts")
        XCTAssertEqual(cuVisibility(of: nil, in: visible), .visible, "no frame is never clipped")
        XCTAssertEqual(cuVisibility(of: CGRect(x: 0, y: 900, width: 0, height: 0), in: visible), .visible, "empty frames may hold visible children")
    }

    func testLongListsFindTheirVisibleRowsWithAFewFrameReads() {
        var reads = 0
        let range = cuVisibleRange(count: 10_000, visible: CGRect(x: 0, y: 2_000, width: 300, height: 400), limit: 400) { index in
            reads += 1
            return CGRect(x: 0, y: Double(index) * 20, width: 300, height: 20)
        }
        XCTAssertEqual(range, 100..<120)
        XCTAssertLessThan(reads, 40)
    }

    func testListsWithoutFramesFallBack() {
        XCTAssertNil(cuVisibleRange(count: 500, visible: visible, limit: 400) { _ in nil })
    }

    func testHiddenItemsAreSummarisedInOneLine() {
        XCTAssertNil(cuScrolledOutSummary(above: 0, below: 0))
        XCTAssertEqual(cuScrolledOutSummary(above: 0, below: 1), "1 more item below, scrolled out of view")
        XCTAssertEqual(cuScrolledOutSummary(above: 12, below: 30), "12 more items above and 30 below, scrolled out of view")
    }

    func testLongValuesAreCutWithTheirRealLength() {
        XCTAssertEqual(cuClipValue("abcdef", limit: 3), "abc…(6 chars)")
        XCTAssertEqual(cuClipValue("abc", limit: 3), "abc")
        let huge = String(repeating: "a", count: 3_000_000)
        XCTAssertEqual(cuClip(huge, 10), String(repeating: "a", count: 10) + "…")
    }
}

final class ComputerWalkReuseTests: XCTestCase {
    private let window = CUElementKey(element: AXUIElementCreateApplication(91_001))
    private let field = CUElementKey(element: AXUIElementCreateApplication(91_002))
    private let other = CUElementKey(element: AXUIElementCreateApplication(91_003))
    private func stamp(events: UInt64 = 5, at: UInt64 = 1_000, frame: CGRect = CGRect(x: 0, y: 0, width: 400, height: 300), focused: CUElementKey? = nil) -> CUWalkStamp {
        CUWalkStamp(events: events, at: at, window: window, frame: frame, focused: focused ?? field)
    }

    func testARepeatedLookWithNoNotificationReusesTheLastWalk() {
        XCTAssertTrue(cuWalkStillCurrent(last: stamp(), now: stamp(at: 1_500), maxAgeNs: 1_000, observingEverything: true))
    }

    func testAnyChangeSignalForcesANewWalk() {
        let last = stamp()
        XCTAssertFalse(cuWalkStillCurrent(last: last, now: stamp(events: 6, at: 1_500), maxAgeNs: 1_000, observingEverything: true), "a notification or an agent step")
        XCTAssertFalse(cuWalkStillCurrent(last: last, now: stamp(at: 1_500, frame: CGRect(x: 0, y: 0, width: 500, height: 300)), maxAgeNs: 1_000, observingEverything: true), "a resize")
        XCTAssertFalse(cuWalkStillCurrent(last: last, now: stamp(at: 1_500, focused: other), maxAgeNs: 1_000, observingEverything: true), "focus moved")
        XCTAssertFalse(cuWalkStillCurrent(last: last, now: stamp(at: 3_000), maxAgeNs: 1_000, observingEverything: true), "too old to trust silence")
        XCTAssertFalse(cuWalkStillCurrent(last: last, now: stamp(at: 1_500), maxAgeNs: 1_000, observingEverything: false), "some notifications are not registered")
        XCTAssertFalse(cuWalkStillCurrent(last: nil, now: stamp(at: 1_500), maxAgeNs: 1_000, observingEverything: true))
    }
}

final class ComputerSettleTests: XCTestCase {
    func testProgressIndicatorsNeverDelaySettling() {
        var noise = CUSettleNoise()
        XCTAssertFalse(noise.counts(element: 1, notification: "AXValueChanged", role: "AXProgressIndicator", now: 0))
        XCTAssertTrue(noise.counts(element: 1, notification: "AXValueChanged", role: "AXTextField", now: 0))
    }

    func testAnElementRepeatingANotificationBecomesNoiseUntilItCalmsDown() {
        var noise = CUSettleNoise(burst: 3, windowNs: 1_000)
        XCTAssertEqual((0..<5).map { noise.counts(element: 9, notification: "AXLayoutChanged", role: nil, now: UInt64($0) * 100) }, [true, true, true, false, false])
        XCTAssertTrue(noise.counts(element: 4, notification: "AXLayoutChanged", role: nil, now: 500), "other elements still count")
        XCTAssertTrue(noise.counts(element: 9, notification: "AXLayoutChanged", role: nil, now: 5_000), "a calm element counts again")
    }
}

final class ComputerClipboardTests: XCTestCase {
    func testSavedClipboardKeepsItemsAndTypesInOrder() throws {
        let save = CUClipboardSave(owner: 42, token: "t", items: [
            CUClipboardItem(entries: [CUClipboardEntry(type: "public.rtf", data: Data([1])), CUClipboardEntry(type: "public.utf8-plain-text", data: Data([2]))]),
            CUClipboardItem(entries: [CUClipboardEntry(type: "public.png", data: Data([3]))]),
        ], unreadable: ["com.example.promise"])
        let decoded = cuDecodeClipboardSave(try cuEncodeClipboardSave(save))
        XCTAssertEqual(decoded, save)
        XCTAssertEqual(decoded?.items.first?.entries.map(\.type), ["public.rtf", "public.utf8-plain-text"])
    }

    func testClipboardIsRestoredOnlyWhileTheAgentsContentIsStillThere() {
        let save = CUClipboardSave(owner: 42, token: "t", items: [], unreadable: [])
        XCTAssertTrue(cuShouldRestore(save, boardToken: "t", ownerAlive: true, isMine: true))
        XCTAssertFalse(cuShouldRestore(save, boardToken: nil, ownerAlive: true, isMine: true), "the person copied something since")
        XCTAssertFalse(cuShouldRestore(save, boardToken: "t", ownerAlive: true, isMine: false), "another live helper is mid-paste")
        XCTAssertTrue(cuShouldRestore(save, boardToken: "t", ownerAlive: false, isMine: false), "a crashed helper's save heals")
        XCTAssertFalse(cuShouldRestore(save, boardToken: "other", ownerAlive: false, isMine: false))
    }
}

final class ComputerPasteImportTests: XCTestCase {
    func testModelHtmlLosesEverythingThatWouldLoadButKeepsTextAndLinks() {
        let html = """
        <p style="background:url(https://x.test/a.png)">Hi <a href="https://example.com">there</a><img src="https://x.test/t.gif"></p>\
        <iframe src="https://x.test/f"></iframe><script>fetch('https://x.test')</script><link rel="stylesheet" href="https://x.test/s.css">
        """
        let offline = cuOfflineHTML(html)
        XCTAssertFalse(offline.contains("x.test"), offline)
        XCTAssertTrue(offline.contains(#"href="https://example.com""#))
        XCTAssertEqual(cuHTMLPlainText(html), "Hi there")
    }
}

final class ComputerCaptureTests: XCTestCase {
    func testScreenshotsUseTheScaleOfTheDisplayShowingTheWindow() {
        let displays = [CUDisplay(frame: CGRect(x: 0, y: 0, width: 1512, height: 982), scale: 2), CUDisplay(frame: CGRect(x: 1512, y: 0, width: 1920, height: 1080), scale: 1)]
        XCTAssertEqual(cuBackingScale(window: CGRect(x: 1600, y: 100, width: 800, height: 600), displays: displays), 1)
        XCTAssertEqual(cuBackingScale(window: CGRect(x: 100, y: 100, width: 800, height: 600), displays: displays), 2)
        XCTAssertEqual(cuBackingScale(window: CGRect(x: 9_000, y: 9_000, width: 800, height: 600), displays: displays), 2, "off every display: the primary's")
    }

    func testUndrawnFramesAreRecognisedAsBlank() throws {
        XCTAssertTrue(cuImageLooksBlank(try image { _ in }))
        XCTAssertTrue(cuImageLooksBlank(try image { $0.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1)); $0.fill(CGRect(x: 0, y: 0, width: 64, height: 64)) }))
        XCTAssertFalse(cuImageLooksBlank(try image { $0.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); $0.fill(CGRect(x: 0, y: 0, width: 64, height: 64)) }))
    }

    private func image(_ draw: (CGContext) -> Void) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        draw(context)
        return try XCTUnwrap(context.makeImage())
    }
}

final class ComputerAppTests: XCTestCase {
    func testChromiumAppsAreRecognisedByFrameworkOrBundleId() {
        XCTAssertTrue(cuIsChromiumFamily(bundleId: "com.tinyspeck.slackmacgap", frameworks: ["Electron Framework.framework", "Squirrel.framework"]))
        XCTAssertTrue(cuIsChromiumFamily(bundleId: "com.google.Chrome", frameworks: []))
        XCTAssertTrue(cuIsChromiumFamily(bundleId: "com.spotify.client", frameworks: ["Chromium Embedded Framework.framework"]))
        XCTAssertFalse(cuIsChromiumFamily(bundleId: "com.apple.TextEdit", frameworks: []))
    }

    func testAppsAnswerToTheirFileNameAsWellAsTheirBundleNames() {
        XCTAssertEqual(cuAppNames(displayName: nil, bundleName: "Code", fileName: "Visual Studio Code.app"), ["Code", "Visual Studio Code"])
        XCTAssertEqual(cuAppNames(displayName: "Safari", bundleName: "Safari", fileName: "Safari.app"), ["Safari"])
        let app = CUInstalledApp(name: "Code", bundleId: "com.microsoft.VSCode", url: URL(fileURLWithPath: "/x"), names: ["Code", "Visual Studio Code"])
        XCTAssertTrue(app.matches(exactly: "visual studio code"))
        XCTAssertTrue(app.matches(partially: "studio"))
    }

    func testAppsInsideVendorFoldersAreFoundOneLevelDown() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cu-apps-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        for path in ["Top.app/Contents", "Adobe Photoshop 2025/Adobe Photoshop 2025.app/Contents", "Deep/Deeper/Hidden.app/Contents"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(path), withIntermediateDirectories: true)
        }
        let found = Set(cuAppBundles(in: root, depth: 1).map(\.lastPathComponent))
        XCTAssertEqual(found, ["Top.app", "Adobe Photoshop 2025.app"])
    }
}
