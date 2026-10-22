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
        let app = fixtureApp(port: busyPort)
        app.launch()
        let busy = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.ios-busy-")).firstMatch
        try XCTSkipUnless(busy.waitForExistence(timeout: 30), "Start the fixture with ACE_IOS_SPIKE_INBOX=300")
        // Two full five-second bridge windows while one row changes every 200 ms.
        XCTAssertTrue(app.waitForCount("bridge.windows", timeout: 15))
        XCTAssertTrue(app.waitForCount("bridge.windows", timeout: 15))
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
        let app = fixtureApp()
        app.launch()
        XCTAssertTrue(app.openThread("ios-stream"))
        let cold = try XCTUnwrap(app.probeValue("open.readyMs"))
        let coldPaint = try XCTUnwrap(app.probeValue("open.paintMs"))
        report("cold open ready (ms)", [cold])
        report("cold open first rows (ms)", [coldPaint])
        XCTAssertLessThan(cold, PerfBudget.coldOpenReadyMs)
        XCTAssertLessThan(coldPaint, PerfBudget.coldOpenPaintMs)
        app.goBack()
        var warm: [Double] = []
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTOSSignpostMetric(subsystem: "app.ace.ios", category: "PointsOfInterest", name: "thread.open"),
                          XCTCPUMetric(application: app), XCTMemoryMetric(application: app)], options: options) {
            if app.openThread("ios-stream"), let ready = app.probeValue("open.readyMs") { warm.append(ready) }
            app.goBack()
        }
        report("warm open ready (ms)", warm)
        XCTAssertFalse(warm.isEmpty)
        XCTAssertLessThan(median(warm), PerfBudget.warmOpenReadyMs)
    }

    func testStreamingIntoAnOpenLongThreadStaysCheap() throws {
        let app = fixtureApp()
        app.launch()
        XCTAssertTrue(app.openThread("ios-stream"))
        // Two windows of streaming at 20 deltas a second with nothing else moving.
        XCTAssertTrue(app.waitForCount("bridge.windows", timeout: 15))
        XCTAssertTrue(app.waitForCount("bridge.windows", timeout: 15))
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
        let after = try XCTUnwrap(app.probeValue("footprintMiB"))
        report("footprint growth over a minute of streaming (MiB)", [after - before])
        XCTAssertLessThan(after - before, PerfBudget.streamingGrowthMiBPerMinute)
    }

    func testScrollingTheLongTranscriptKeepsFramesOnTime() throws {
        let app = fixtureApp()
        app.launch()
        XCTAssertTrue(app.openThread("ios-stream"))
        let list = app.scrollViews.firstMatch
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric, XCTCPUMetric(application: app)], options: options) {
            list.swipeDown(velocity: .fast)
            list.swipeDown(velocity: .fast)
            list.swipeUp(velocity: .fast)
            list.swipeUp(velocity: .fast)
        }
        _ = app.waitForCount("frames.windows", timeout: 10)
        let hitches = try XCTUnwrap(app.probeValue("frames.hitchMsPerS"))
        report("transcript scroll hitch time (ms per s)", [hitches])
        XCTAssertLessThan(hitches, PerfBudget.scrollHitchMsPerS)
    }

    func testTypingWithTheLongThreadBehindIt() throws {
        let app = fixtureApp()
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
