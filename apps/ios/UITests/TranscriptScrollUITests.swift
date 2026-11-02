import XCTest

/// Reading a long thread back and forth, against the fixture's finished 120-turn conversation
/// (`ios-reading`, with an HTML chart every tenth turn). Start the fixture with
/// `bun run spike:daemon` (and `TEST_RUNNER_ACE_IOS_SPIKE_PORT` for another port).
///
/// History read once stays loaded: reading back over it again asks the bridge for nothing, keeps
/// the one reading window, and its rows (charts included) come back at the height they had.
@MainActor final class TranscriptScrollUITests: XCTestCase {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
    override func setUp() { continueAfterFailure = false }

    func testReadingBackOverLoadedHistoryKeepsItsRowsAndHeights() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port, "--spike-open", "ios-reading", "--perf-probe"]
        app.launch()
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 30))
        expectation(for: NSPredicate(format: "value == 'Ready'"), evaluatedWith: transcript)
        waitForExpectations(timeout: 30)

        let began = Date()
        let busyBefore = app.probeValue("main.busyMsTotal") ?? 0
        let lostBefore = app.probeValue("frames.lostMsTotal") ?? 0

        // First trip back: older pages load as the reader nears the top of what is loaded.
        var flings = 0
        while (app.probeValue("pages.older") ?? 0) < 3, flings < 40 {
            transcript.fling(older: true)
            flings += 1
        }
        let olderRead = app.probeValue("pages.older") ?? 0
        XCTAssertGreaterThanOrEqual(olderRead, 3, "older pages read in \(flings) flings")
        settle()
        let resizedAfterFirstTrip = app.probeValue("rows.resized") ?? 0
        let canvasAfterFirstTrip = app.probeValue("canvas.loads") ?? 0
        let fetchesAfterFirstTrip = app.probeValue("media.fetches") ?? 0

        // Down to the end and back over the same history, twice.
        for trip in 1...2 {
            for _ in 0..<(flings + 4) { transcript.fling(older: false) }
            settle()
            for _ in 0..<max(flings - 2, 1) { transcript.fling(older: true) }
            settle()
            attach("trip-\(trip)-back", app)
        }

        let spent = Date().timeIntervalSince(began)
        let busy = (app.probeValue("main.busyMsTotal") ?? 0) - busyBefore
        let lost = (app.probeValue("frames.lostMsTotal") ?? 0) - lostBefore
        let olderAgain = (app.probeValue("pages.older") ?? 0) - olderRead
        let resized = (app.probeValue("rows.resized") ?? 0) - resizedAfterFirstTrip
        let canvas = (app.probeValue("canvas.loads") ?? 0) - canvasAfterFirstTrip
        let fetches = (app.probeValue("media.fetches") ?? 0) - fetchesAfterFirstTrip
        let summary = """
            scroll: spent=\(String(format: "%.1f", spent))s mainBusy=\(String(format: "%.1f", busy / (spent * 10)))% \
            hitchMsPerS=\(String(format: "%.1f", lost / spent)) olderFirstTrip=\(olderRead) olderAgain=\(olderAgain) \
            windows=\(app.probeValue("reading.windows") ?? 0) live=\(app.probeValue("pages.live") ?? 0) \
            holds=\(app.probeValue("pages.hold") ?? 0) follows=\(app.probeValue("pages.follow") ?? 0) \
            resizedAgain=\(resized) canvasLoadsAgain=\(canvas) mediaFetchesAgain=\(fetches) \
            appeared=\(app.probeValue("rows.appeared") ?? 0)
            """
        print(summary)
        let note = XCTAttachment(string: summary)
        note.name = "scroll-numbers"
        note.lifetime = .keepAlways
        add(note)

        XCTAssertEqual(olderAgain, 0, "Reading back over loaded history must not read it again")
        XCTAssertEqual(app.probeValue("reading.windows") ?? 0, 1, "One reading window for the whole visit")
        XCTAssertEqual(app.probeValue("pages.live") ?? 0, 0, "Reaching the end must not discard loaded history")
        XCTAssertEqual(fetches, 0, "Charts come back from the cache")
        XCTAssertEqual(canvas, 0, "Charts scrolled back into view keep their page")
        XCTAssertEqual(resized, 0, "Rows come back at the height they had")
    }

    /// Lets a fling's momentum and the page it asked for finish.
    private func settle() {
        _ = XCTWaiter.wait(for: [XCTestExpectation(description: "settle")], timeout: 1.5)
    }

    private func attach(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
