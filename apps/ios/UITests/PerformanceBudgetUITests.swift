import XCTest

/// Performance budgets for the main flows, against the fixture started as
/// `ACE_IOS_SPIKE_PORT=<port> ACE_IOS_SPIKE_STREAMED=650000 bun run spike:daemon`, plus, for the
/// busy inbox, a second one with `ACE_IOS_SPIKE_INBOX=300` on `ACE_IOS_SPIKE_BUSY_PORT`. Run with
/// the `AcePerf` scheme (Release optimisation, see README "Performance budgets").
/// Each test reports Xcode metrics through `measure(metrics:)` and fails when the app's own
/// numbers (`--perf-probe`, `Sources/Spike/PerfProbe.swift`) pass a budget in `PerfBudget`.
/// Spends no provider quota.
@MainActor final class PerformanceBudgetUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testLaunchShowsInboxRowsWithinBudget() throws {
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)], options: options) {
            fixtureApp().launch()
        }
        var rows: [Double] = []
        for _ in 0..<5 {
            let app = fixtureApp()
            app.launch()
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.")).firstMatch.waitForExistence(timeout: 30))
            rows.append(try XCTUnwrap(app.waitForProbe("launch.inbox.rowsOnScreen")))
            app.terminate()
        }
        report("launch to inbox rows (ms)", rows)
        XCTAssertLessThan(median(rows), PerfBudget.launchRowsMs, "inbox rows on screen after launch")
    }

    func testBusyInboxSendsOnlyTheRowsThatChange() throws {
        let busyPort = try XCTUnwrap(ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_BUSY_PORT"],
                                     "Set TEST_RUNNER_ACE_IOS_SPIKE_BUSY_PORT to a fixture started with ACE_IOS_SPIKE_INBOX=300")
        let seeded = try XCTUnwrap(try fixtureHealth(port: busyPort)["busy"] as? Int, "fixture /health has no busy count")
        XCTAssertGreaterThanOrEqual(seeded, Workload.busyThreads, "Start the busy fixture with ACE_IOS_SPIKE_INBOX=\(Workload.busyThreads)")
        let app = fixtureApp(port: busyPort)
        app.launch()
        let busy = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.ios-busy-")).firstMatch
        XCTAssertTrue(busy.waitForExistence(timeout: 30), "no busy rows listed")
        // Two full five-second bridge windows while one row changes every 200 ms.
        XCTAssertTrue(app.waitForCount("bridge.windows", timeout: 15))
        XCTAssertTrue(app.waitForCount("bridge.windows", timeout: 15))
        // The app holds every busy row, so the window measured the whole population.
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(app.probeValue("inbox.rows")), Double(Workload.busyThreads), "inbox rows held")
        let patches = try XCTUnwrap(app.probeValue("bridge.patches"))
        let bytes = try XCTUnwrap(app.probeValue("bridge.bytes"))
        let main = try XCTUnwrap(app.probeValue("bridge.mainMs"))
        report("busy inbox per 5 s: patches", [patches])
        report("busy inbox per 5 s: bytes", [bytes])
        report("busy inbox per 5 s: main-thread apply ms", [main])
        XCTAssertLessThan(patches, PerfBudget.busyInboxPatchesPer5s)
        XCTAssertLessThan(bytes, PerfBudget.busyInboxBytesPer5s)
        XCTAssertLessThan(main, PerfBudget.busyInboxMainMsPer5s)
        let list = app.collectionViews.firstMatch
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric, XCTCPUMetric(application: app)], options: options) {
            list.swipeUp(velocity: .fast)
            list.swipeUp(velocity: .fast)
            list.swipeDown(velocity: .fast)
            list.swipeDown(velocity: .fast)
        }
    }

    func testOpeningTheLongLiveThreadColdThenWarm() throws {
        let app = try longThreadApp()
        app.launch()
        XCTAssertTrue(app.openThread("ios-stream"))
        XCTAssertEqual(app.probe["open.thread"], "ios-stream")
        XCTAssertEqual(app.probe["open.warm"], "false")
        let cold = try XCTUnwrap(app.probeValue("open.readyMs"))
        let coldPaint = try XCTUnwrap(app.probeValue("open.paintMs"))
        report("cold open ready (ms)", [cold])
        report("cold open first rows (ms)", [coldPaint])
        XCTAssertLessThan(cold, PerfBudget.coldOpenReadyMs)
        XCTAssertLessThan(coldPaint, PerfBudget.coldOpenPaintMs)
        app.goBack()
        var warm: [Double] = [], failures: [String] = [], attempts = 0
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTOSSignpostMetric(subsystem: "app.ace.ios", category: "PointsOfInterest", name: "thread.open"),
                          XCTCPUMetric(application: app), XCTMemoryMetric(application: app)], options: options) {
            attempts += 1
            // Every open must finish, as a warm open of this thread, with a ready time.
            let opened = app.openThread("ios-stream")
            let probe = app.probe
            if opened, probe["open.thread"] == "ios-stream", probe["open.warm"] == "true",
               let ready = probe["open.readyMs"].flatMap(Double.init) {
                warm.append(ready)
            } else {
                failures.append("open \(attempts): opened=\(opened) thread=\(probe["open.thread"] ?? "-") warm=\(probe["open.warm"] ?? "-") ready=\(probe["open.readyMs"] ?? "-")")
            }
            app.goBack()
        }
        report("warm open ready (ms)", warm)
        XCTAssertEqual(failures, [], "every warm open finishes with a timing")
        XCTAssertEqual(warm.count, attempts)
        XCTAssertLessThan(median(warm), PerfBudget.warmOpenReadyMs)
    }

    func testStreamingIntoAnOpenLongThreadStaysCheap() throws {
        let app = try longThreadApp()
        app.launch()
        XCTAssertTrue(app.openThread("ios-stream"))
        let sent = try streamedDeltas()
        // Two windows of streaming at 20 deltas a second with nothing else moving.
        XCTAssertTrue(app.waitForCount("bridge.windows", timeout: 15))
        XCTAssertTrue(app.waitForCount("bridge.windows", timeout: 15))
        // The window measured the stream: the fixture kept sending and the app applied it.
        XCTAssertGreaterThan(try streamedDeltas(), sent, "the fixture stopped streaming")
        let updates = app.probeValue("bridge.rowUpdates") ?? 0
        report("streaming per 5 s: row updates applied", [updates])
        XCTExpectFailure(Workload.longStreamFreezes) {
            XCTAssertGreaterThanOrEqual(updates, Workload.streamingRowUpdatesPer5s, "streamed row updates applied")
        }
        let main = try XCTUnwrap(app.probeValue("bridge.mainMs"))
        let script = try XCTUnwrap(app.probeValue("bridge.scriptMs"))
        let bytes = try XCTUnwrap(app.probeValue("bridge.bytes"))
        report("streaming per 5 s: main-thread apply ms", [main])
        report("streaming per 5 s: script ms", [script])
        report("streaming per 5 s: bytes", [bytes])
        XCTAssertLessThan(main, PerfBudget.streamingMainMsPer5s)
        XCTAssertLessThan(script, PerfBudget.streamingScriptMsPer5s)
        XCTAssertLessThan(bytes, PerfBudget.streamingBytesPer5s)
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTCPUMetric(application: app), XCTMemoryMetric(application: app)], options: options) {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 5))
        }
        let before = try XCTUnwrap(app.probeValue("footprintMiB"))
        // A minute of streaming with the thread left open; each bridge window records the footprint.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 60))
        XCTAssertTrue(app.waitForCount("bridge.windows", timeout: 15))
        let later = app.probeValue("bridge.rowUpdates") ?? 0
        XCTExpectFailure(Workload.longStreamFreezes) {
            XCTAssertGreaterThanOrEqual(later, Workload.streamingRowUpdatesPer5s, "still streaming after a minute")
        }
        let after = try XCTUnwrap(app.probeValue("footprintMiB"))
        report("footprint growth over a minute of streaming (MiB)", [after - before])
        XCTAssertLessThan(after - before, PerfBudget.streamingGrowthMiBPerMinute)
    }

    func testScrollingTheLongTranscriptKeepsFramesOnTime() throws {
        let app = try longThreadApp()
        app.launch()
        XCTAssertTrue(app.openThread("ios-stream"))
        let windowsBefore = app.probe["frames.windows"]
        let list = app.scrollViews.firstMatch
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        // Late-frame time lost during each run of swipes alone: the sampler's running total,
        // read just before and just after them, over the time the swipes took.
        var lostMs: [Double] = [], spentS: [Double] = []
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric, XCTCPUMetric(application: app)], options: options) {
            let lostBefore = app.probeValue("frames.lostMsTotal") ?? 0
            let began = Date()
            list.swipeDown(velocity: .fast)
            list.swipeDown(velocity: .fast)
            list.swipeUp(velocity: .fast)
            list.swipeUp(velocity: .fast)
            spentS.append(Date().timeIntervalSince(began))
            lostMs.append((app.probeValue("frames.lostMsTotal") ?? 0) - lostBefore)
        }
        // The sampler ran while the thread was on screen (it reports every five seconds).
        XCTAssertTrue(app.waitForCount("frames.windows", from: windowsBefore, timeout: 10), "frame sampler never reported")
        report("transcript scroll lost frame time per run (ms)", lostMs)
        report("transcript scroll run length (s)", spentS)
        let hitches = lostMs.reduce(0, +) / max(spentS.reduce(0, +), 0.001)
        report("transcript scroll hitch time (ms per s)", [hitches])
        XCTAssertLessThan(hitches, PerfBudget.scrollHitchMsPerS)
    }

    /// Reading far back through a history longer than the window (`ACE_IOS_SPIKE_HISTORY`), then
    /// back toward live: memory stays flat as the window slides and evicts, each page costs the
    /// main thread little, and frames stay on time while pages land under the finger.
    func testReadingFarBackKeepsMemoryAndFramesBounded() throws {
        let history = try XCTUnwrap(try fixtureHealth()["history"] as? Int, "fixture /health has no history count")
        XCTAssertGreaterThanOrEqual(history, Workload.longHistoryItems,
                                    "Start the fixture with ACE_IOS_SPIKE_HISTORY=\(Workload.longHistoryItems)")
        let app = try longThreadApp()
        app.launch()
        XCTAssertTrue(app.openThread("ios-stream"))
        let list = app.scrollViews["transcript"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        let opened = try XCTUnwrap(app.probeValue("footprintMiB"))
        let lostBefore = app.probeValue("frames.lostMsTotal") ?? 0
        let began = Date()
        var swipes = 0
        // Toward older, until the window has slid well past its bound.
        while (app.probeValue("pages.older") ?? 0) < Workload.olderPages, swipes < 600 {
            list.fling(older: true)
            swipes += 1
        }
        let older = app.probeValue("pages.older") ?? 0
        XCTAssertGreaterThanOrEqual(older, Workload.olderPages, "older pages read in \(swipes) swipes")
        let farBack = try XCTUnwrap(app.probeValue("page.footprintMiB"))
        // Back toward live for a few pages: the window slides the other way.
        swipes = 0
        while (app.probeValue("pages.newer") ?? 0) < Workload.newerPages, swipes < 300 {
            list.fling(older: false)
            swipes += 1
        }
        XCTAssertGreaterThanOrEqual(app.probeValue("pages.newer") ?? 0, Workload.newerPages, "newer pages read")
        let spent = Date().timeIntervalSince(began)
        let lost = (app.probeValue("frames.lostMsTotal") ?? 0) - lostBefore
        let pages = (app.probeValue("pages.older") ?? 0) + (app.probeValue("pages.newer") ?? 0)
        let mainPerPage = (app.probeValue("page.mainMsTotal") ?? 0) / max(pages, 1)
        let peak = try XCTUnwrap(app.probeValue("page.peakMiB"))
        report("reading far back: pages older, newer", [older, app.probeValue("pages.newer") ?? 0])
        report("reading far back: main-thread ms per page", [mainPerPage])
        report("reading far back: late-frame ms per s", [lost / max(spent, 0.001)])
        report("reading far back: footprint opened, far back, peak (MiB)", [opened, farBack, peak])
        XCTAssertLessThan(mainPerPage, PerfBudget.pageMainMs)
        XCTAssertLessThan(lost / max(spent, 0.001), PerfBudget.readingHitchMsPerS)
        XCTAssertLessThan(peak - opened, PerfBudget.readingGrowthMiB)
        // Scroll to end discards the window and follows the live end again.
        app.buttons["Scroll to end"].tap()
        let value = NSPredicate(format: "value == %@", "Ready")
        XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: value, evaluatedWith: list)], timeout: 10), .completed)
    }

    func testTypingWithTheLongThreadBehindIt() throws {
        let app = try longThreadApp()
        app.launch()
        XCTAssertTrue(app.openThread("ios-stream"))
        let field = app.textViews["composer.input"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        var spans: [Double] = []
        measure(metrics: [XCTClockMetric(), XCTCPUMetric(application: app)], options: options) {
            let began = Date()
            field.typeText("Keep process ownership explicit. ")
            spans.append(Date().timeIntervalSince(began) * 1000)
        }
        report("typing 33 characters (ms)", spans)
        XCTAssertLessThan(median(spans), PerfBudget.typingMs)
    }

    func testThreadSheetsFillWithinBudget() throws {
        let app = fixtureApp()
        app.launch()
        app.openThread("ios-tree", timeout: 1)
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        var agents: [Double] = [], changes: [Double] = [], models: [Double] = []
        for _ in 0..<3 {
            // In-app: from the sheet asking the bridge to its rows applied (`sheet.open` signpost).
            var before = app.probe["sheets"]
            app.openAgents()
            XCTAssertTrue(app.waitForCount("sheets", from: before, timeout: 15))
            agents.append(try XCTUnwrap(app.probeValue("sheet.agentsMs")))
            app.buttons["agents.close"].tap()
            before = app.probe["sheets"]
            app.buttons["thread.menu"].tap()
            app.buttons["thread.changes"].tap()
            XCTAssertTrue(app.waitForCount("sheets", from: before, timeout: 15))
            changes.append(try XCTUnwrap(app.probeValue("sheet.changesMs")))
            app.buttons["changes.close"].tap()
            // The model sheet reads nothing; this is tap to shown, XCUITest's own time included.
            models.append(timed {
                app.buttons["composer.model"].tap()
                XCTAssertTrue(app.buttons["modelSheet.close"].waitForExistence(timeout: 15))
            })
            app.buttons["modelSheet.close"].tap()
        }
        report("Agents sheet rows (ms, asked to applied)", agents)
        report("Changes sheet rows (ms, asked to applied)", changes)
        report("model sheet (ms, tap to shown, test overhead included)", models)
        XCTAssertLessThan(median(agents), PerfBudget.sheetFillMs)
        XCTAssertLessThan(median(changes), PerfBudget.sheetFillMs)
        XCTAssertLessThan(median(models), PerfBudget.modelSheetTapMs)
    }

    // MARK: - Helpers

    private func fixtureApp(port: String = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841") -> XCUIApplication {
        let app = XCUIApplication()
        // The paired app's window: the latest 200 items, older ones paged in behind them.
        app.launchArguments = ["--spike", "--spike-port", port, "--spike-items", "200", "--perf-probe"]
        return app
    }
    /// The app on the long-thread fixture, refusing one started without its seeded history.
    private func longThreadApp() throws -> XCUIApplication {
        let seeded = try XCTUnwrap(try fixtureHealth()["streamed"] as? Int, "fixture /health has no streamed count")
        XCTAssertGreaterThanOrEqual(seeded, Workload.longThreadDeltas,
                                    "Start the fixture with ACE_IOS_SPIKE_STREAMED=\(Workload.longThreadDeltas)")
        return fixtureApp()
    }
    /// Deltas the long-thread fixture has streamed so far, the seed included.
    private func streamedDeltas() throws -> Int {
        try XCTUnwrap(try fixtureHealth()["deltas"] as? Int, "fixture /health has no deltas count")
    }
    private func fixtureHealth(port: String = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841") throws -> [String: Any] {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/health"))
        let done = expectation(description: "fixture health")
        let body = HealthBody()
        URLSession.shared.dataTask(with: url) { data, _, _ in body.set(data); done.fulfill() }.resume()
        wait(for: [done], timeout: 10)
        let data = try XCTUnwrap(body.data, "fixture on port \(port) did not answer /health")
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    private func timed(_ body: () -> Void) -> Double {
        let began = Date()
        body()
        return Date().timeIntervalSince(began) * 1000
    }
    private func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        return sorted.isEmpty ? .infinity : sorted[sorted.count / 2]
    }
    private func report(_ name: String, _ values: [Double]) {
        let line = "\(name): " + values.map { String(format: "%.1f", $0) }.joined(separator: ", ")
        print("perf-budget \(line)")
        let attachment = XCTAttachment(string: line)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

/// The fixture's `/health` reply, handed from URLSession's queue to the test.
private final class HealthBody: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Data?
    var data: Data? { lock.withLock { stored } }
    func set(_ data: Data?) { lock.withLock { stored = data } }
}

/// The workload the budgets assume; a fixture without it fails the test rather than passing cheaply.
enum Workload {
    static let longThreadDeltas = 650_000         // ACE_IOS_SPIKE_STREAMED
    static let busyThreads = 300                  // ACE_IOS_SPIKE_INBOX
    static let longHistoryItems = 8_000           // ACE_IOS_SPIKE_HISTORY
    /// Older pages read: about 5,000 items, two and a half times the window's bound.
    static let olderPages = 25.0
    static let newerPages = 5.0
    static let streamingRowUpdatesPer5s = 50.0    // the fixture streams 100 deltas (20 a second)
    /// Known bug, 2026-10-22: with ACE_IOS_SPIKE_STREAMED of 1,000 or more, the open thread's
    /// streaming row stops updating after the open (only `thread.cursor` patches arrive; the screen
    /// stays on the step it opened at), while an unseeded or 1-delta seed streams. The bridge alone
    /// (`thread-harness.ts`) streams it, so the loss is between the patch pump and native. Strict:
    /// once fixed, these expectations fail until the wrapper goes. Until then the streaming budgets
    /// measure cursor traffic, not text.
    static let longStreamFreezes = "a long seeded stream stops updating on screen (see Workload)"
}

/// The budgets, on the iOS 26 simulator with the `Perf` configuration. Each sits about 1.5 to 5
/// times above the measured median (README "Performance budgets"), so a real regression fails
/// while a busy Mac does not. Lower them when the app gets faster; never raise one without a measured reason.
enum PerfBudget {
    // Measured medians in brackets (Perf, iOS 26 simulator, 2026-10-22).
    static let launchRowsMs = 1_700.0             // [1,157]
    static let busyInboxPatchesPer5s = 400.0      // [50; 8,200 when every row was resent]
    static let busyInboxBytesPer5s = 800_000.0    // [614,000; 6.3 MB before]
    static let busyInboxMainMsPer5s = 40.0        // [15; 155 before]
    static let coldOpenReadyMs = 700.0            // [317]
    static let coldOpenPaintMs = 800.0            // [387]
    static let warmOpenReadyMs = 500.0            // [280]
    static let streamingMainMsPer5s = 30.0        // [5.4]
    static let streamingScriptMsPer5s = 250.0     // [95]
    static let streamingBytesPer5s = 40_000.0     // [7,400]
    static let streamingGrowthMiBPerMinute = 8.0  // [-1]
    static let scrollHitchMsPerS = 60.0           // [13.6]
    static let typingMs = 1_800.0                 // [830, XCUITest's own typing pace]
    static let sheetFillMs = 350.0                // [Agents 140, Changes 128]
    static let modelSheetTapMs = 3_000.0          // [1,940, mostly XCUITest waiting]
    static let pageMainMs = 1_000.0               // [measuring]
    static let readingHitchMsPerS = 1_000.0       // [measuring]
    static let readingGrowthMiB = 1_000.0         // [measuring]
}

extension XCUIElement {
    /// One fast fling, several screens long: toward older rows (down the screen) or newer.
    func fling(older: Bool) {
        let from = coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.3 : 0.75))
        let to = coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.75 : 0.3))
        from.press(forDuration: 0.01, thenDragTo: to, withVelocity: XCUIGestureVelocity(6_000), thenHoldForDuration: 0)
    }
}

extension XCUIApplication {
    /// The app's `--perf-probe` numbers.
    var probe: [String: String] {
        let text = descendants(matching: .any)["perf.probe"].value as? String ?? ""
        var values: [String: String] = [:]
        for pair in text.split(separator: ";") {
            let parts = pair.split(separator: "=", maxSplits: 1)
            if parts.count == 2 { values[String(parts[0])] = String(parts[1]) }
        }
        return values
    }
    func probeValue(_ key: String) -> Double? { probe[key].flatMap(Double.init) }
    /// Waits until `key` has a value.
    func waitForProbe(_ key: String, timeout: TimeInterval = 20) -> Double? {
        let deadline = Date(timeIntervalSinceNow: timeout)
        repeat {
            if let value = probeValue(key) { return value }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25))
        } while Date() < deadline
        return nil
    }
    /// Waits until the counter `key` (opens, bridge or frame windows) moves on.
    func waitForCount(_ key: String, from start: String?? = nil, timeout: TimeInterval = 20) -> Bool {
        let before = start ?? probe[key]
        let deadline = Date(timeIntervalSinceNow: timeout)
        repeat {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25))
            if let now = probe[key], now != before { return true }
        } while Date() < deadline
        return false
    }
    /// Opens a thread from its inbox row; true once the app reports the open finished.
    @discardableResult func openThread(_ id: String, timeout: TimeInterval = 30) -> Bool {
        let row = revealRow("thread.\(id)")
        let before = probe["opens"]
        row.tap()
        return waitForCount("opens", from: before, timeout: timeout)
    }
    /// Back to the inbox from a thread.
    func goBack() {
        navigationBars.buttons.firstMatch.tap()
        let composer = textViews["composer.input"]
        let deadline = Date(timeIntervalSinceNow: 10)
        while composer.exists && Date() < deadline { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1)) }
    }
}
