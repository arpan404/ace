import XCTest

/// The transcript's rows don't move by themselves: a thread opens drawn where it stays, and an
/// older page landing leaves the reader's line where it was. Read each frame from what is drawn
/// (`TranscriptJumpProbe`).
@MainActor final class TranscriptJumpUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    /// A long finished thread opens at its end: from the first frame its rows are drawn, they
    /// don't move.
    func testALongFinishedThreadOpensWhereItStays() {
        let app = open("ios-log-long")
        let run = jumpRun(app, "open")
        print("jump open ios-log-long: \(run) reveal=\(app.probe["jump.reveal.ms"] ?? "-")ms capped=\(app.probe["jump.reveal.capped"] ?? "-")")
        XCTAssertGreaterThan(run.frames, 30, "frames were sampled: \(run)")
        XCTAssertEqual(run.moved, 0, "the rows stay where they were first drawn: \(run)")
        assertLandedAtEnd(app)
    }

    /// A live thread opens at its streaming end: the rows only ever move up with the answer as it
    /// grows, a line or so at a time, never jumping back or across the screen.
    func testALiveThreadOpensAtItsEndAndOnlyFollowsIt() {
        let app = open("ios-stream")
        let run = jumpRun(app, "open")
        print("jump open ios-stream: \(run) reveal=\(app.probe["jump.reveal.ms"] ?? "-")ms capped=\(app.probe["jump.reveal.capped"] ?? "-")")
        XCTAssertGreaterThan(run.frames, 30, "frames were sampled: \(run)")
        XCTAssertFalse(run.trace.contains("swap"), "the screen is never replaced: \(run)")
        XCTAssertLessThanOrEqual(run.onScreen.max() ?? 0, 0, "rows never move down: \(run)")
        XCTAssertGreaterThanOrEqual(run.onScreen.min() ?? 0, -60, "rows move up a line or so at a time: \(run)")
        assertLandedAtEnd(app)
    }

    /// Reading back, an older page lands above the rows on screen without moving them: it joins
    /// once the fling has come to rest, and the line stays within a point while the offset takes
    /// the page's height.
    func testAnOlderPageLandsWithoutMovingTheReadersLine() {
        let app = open("ios-reading")
        _ = jumpRun(app, "open")
        let transcript = app.scrollViews["transcript"]
        for _ in 0..<20 where (app.probeValue("jump.older.runs") ?? 0) < 2 {
            transcript.fling(older: true)
        }
        XCTAssertTrue(app.waitForProbe("jump.older.runs", atLeast: 2, timeout: 20), "two older pages loaded")
        let pages = [jumpRun(app, "older.1"), jumpRun(app, "older.2")]
        for (n, page) in pages.enumerated() { print("jump older ios-reading page \(n + 1): \(page)") }
        for page in pages { XCTAssertGreaterThan(page.frames, 30, "frames were sampled: \(page)") }
        for page in pages {
            XCTAssertFalse(page.trace.contains("swap"), "no frame replaced the whole screen: \(page)")
            XCTAssertTrue(page.atRest.contains { abs($0.inContent) >= 100 }, "the page joined while the feed was at rest: \(page)")
            let most = page.atRest.map { abs($0.onScreen) }.max() ?? 0
            XCTAssertLessThanOrEqual(most, 1, "the rows on screen stayed put while the page joined: \(page)")
        }
    }

    private func open(_ threadId: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841",
                               "--spike-open", threadId, "--perf-probe"]
        app.launchWithArguments()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 30))
        return app
    }

    /// The opened feed was shown at its end, not on its way there.
    private func assertLandedAtEnd(_ app: XCUIApplication) {
        let fromEnd = app.waitForProbe("jump.landed.fromEnd", timeout: 10)
        XCTAssertNotNil(fromEnd, "the probe read where the feed landed")
        XCTAssertLessThanOrEqual(fromEnd ?? .infinity, 1, "the feed showed at its end")
    }

    /// The probe's last `name` run, once it has recorded one.
    private func jumpRun(_ app: XCUIApplication, _ name: String) -> JumpRun {
        XCTAssertNotNil(app.waitForProbe("jump.\(name).frames", timeout: 30), "the probe recorded a \(name) run")
        let probe = app.probe
        func number(_ key: String) -> Int { Int(probe["jump.\(name).\(key)"] ?? "") ?? -1 }
        return JumpRun(frames: number("frames"), moved: number("moved"), total: number("total"), max: number("max"),
                       trace: probe["jump.\(name).trace"] ?? "")
    }
}

/// One run of `TranscriptJumpProbe`.
struct JumpRun: CustomStringConvertible {
    let frames: Int
    let moved: Int
    let total: Int
    let max: Int
    let trace: String
    /// Each frame's move on screen, in points, from the trace's `<on screen>/<in content><phase>`.
    var onScreen: [Int] { trace.split(separator: ",").compactMap { $0.split(separator: "/").count == 2 ? Int($0.split(separator: "/")[0]) : nil } }
    /// The frames that moved while the feed was at rest (`i`): on screen and within the content.
    var atRest: [(onScreen: Int, inContent: Int)] {
        trace.split(separator: ",").compactMap { entry -> (onScreen: Int, inContent: Int)? in
            guard entry.hasSuffix("i") else { return nil }
            let parts = entry.dropLast().split(separator: "/")
            guard parts.count == 2, let on = Int(parts[0]), let inside = Int(parts[1]) else { return nil }
            return (onScreen: on, inContent: inside)
        }
    }
    var description: String { "frames=\(frames) moved=\(moved) total=\(total)pt max=\(max)pt trace=[\(trace)]" }
}
