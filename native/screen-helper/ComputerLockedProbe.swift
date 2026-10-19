import AppKit
import ApplicationServices

/// Diagnostic only: records which computer-use mechanisms still work while the Mac is locked.
/// The engine never calls it. Run as
/// `ACE_CU_PROBE=1 ace-screen-helper --probe-locked --out FILE [--runs N] [--interval S]`,
/// `... --probe-locked --cleanup` (closes the TextEdit documents the probe created) or
/// `... --probe-locked --lockstate` (prints whether the session is locked).
///
/// It works only on what it creates: a new TextEdit document (File > New, closed without
/// saving) and the Calculator. Existing TextEdit documents are never touched.
@available(macOS 14.0, *)
@MainActor enum CULockedProbe {
    static func main() async -> Never {
        guard ProcessInfo.processInfo.environment["ACE_CU_PROBE"] == "1" else {
            FileHandle.standardError.write(Data("ace-screen-helper: --probe-locked needs ACE_CU_PROBE=1\n".utf8))
            exit(2)
        }
        NSApplication.shared.setActivationPolicy(.accessory)
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), cuAXTimeout)
        let arguments = CommandLine.arguments
        func value(_ flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
            return arguments[index + 1]
        }
        if arguments.contains("--lockstate") {
            print(cuScreenLocked() ? "locked" : "unlocked")
            exit(0)
        }
        if arguments.contains("--list") {
            print(cuProbeJSON(["textEditWindows": await list()]))
            exit(0)
        }
        if arguments.contains("--cleanup") {
            print(cuProbeJSON(await cleanup()))
            exit(0)
        }
        let runs = max(1, Int(value("--runs") ?? "") ?? 1)
        let interval = max(0, Double(value("--interval") ?? "") ?? 20)
        try? FileManager.default.createDirectory(atPath: cuProbeImageDirectory, withIntermediateDirectories: true)
        var results: [CUObject] = []
        let started = Date()
        for index in 0..<runs {
            if index > 0 { try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000)) }
            var run = await probeOnce(index: index)
            run["secondsSinceStart"] = Int(Date().timeIntervalSince(started))
            results.append(run)
            FileHandle.standardError.write(Data("probe run \(index + 1)/\(runs) done\n".utf8))
        }
        let report: CUObject = ["startedAt": ISO8601DateFormatter().string(from: started), "macOS": ProcessInfo.processInfo.operatingSystemVersionString, "runs": results]
        let text = cuProbeJSON(report)
        if let out = value("--out") {
            do { try text.write(toFile: out, atomically: true, encoding: .utf8) } catch {
                FileHandle.standardError.write(Data("probe: could not write \(out): \(error)\n".utf8))
                exit(1)
            }
        } else {
            print(text)
        }
        exit(0)
    }

    /// One pass over every capability, in the order an agent would use them.
    static func probeOnce(index: Int) async -> CUObject {
        let steps = CUProbeSteps()
        let tag = "run\(index + 1)"
        await steps.record("lock_state") { cuProbeLockFacts() }
        await steps.record("power_assertion_prevent_idle_system_sleep") { cuProbePowerAssertion() }
        await steps.record("clipboard_write_read") { cuProbeClipboard() }

        let calculator = await steps.app("com.apple.calculator")
        if let calculator {
            await steps.record("calculator_ax_tree_read") { cuProbeTreeRead(calculator) }
            await steps.record("calculator_ax_press_7_plus_2_equals") { cuProbeCalculatorPress(calculator) }
            await steps.record("calculator_posted_click_5") { await cuProbeCalculatorPostedClick(calculator) }
            await steps.record("calculator_capture") { await cuProbeCaptures(calculator, window: cuProbeFirstWindow(calculator), name: "\(tag)-calculator") }
        }

        guard let textEdit = await steps.app("com.apple.TextEdit") else { return steps.result }
        var document: AXUIElement?
        await steps.record("textedit_ax_menu_press_file_new") {
            let (window, detail) = await cuProbeNewDocument(textEdit)
            document = window
            return (window != nil, detail)
        }
        if let document {
            await steps.record("textedit_ax_tree_read") { cuProbeTreeRead(textEdit, window: document) }
            await steps.record("textedit_ax_value_set") { cuProbeSetValue(document) }
            await steps.record("textedit_ax_selected_text_insert") { cuProbeSelectedTextInsert(document) }
            await steps.record("textedit_ax_menu_press_edit_select_all") { await cuProbeSelectAll(textEdit, document: document) }
            await steps.record("textedit_posted_keys") { await cuProbePostedKeys(textEdit, document: document) }
            await steps.record("textedit_capture") { await cuProbeCaptures(textEdit, window: document, name: "\(tag)-textedit") }
            await steps.record("textedit_close_without_saving") {
                let closed = await cuProbeCloseDocument(textEdit, window: document)
                return (closed.ok, closed.detail)
            }
        }
        await steps.record("display_capture") { await cuProbeDisplayCapture(name: "\(tag)-display") }
        await steps.record("lock_state_after") { cuProbeLockFacts() }
        return steps.result
    }

    /// Closes every document the probe created that is still open.
    /// Only windows whose window-server number the probe recorded are ever closed.
    static func cleanup() async -> CUObject {
        guard let text = try? String(contentsOfFile: cuProbeLedger, encoding: .utf8),
              let app = cuProbeRunningApp("com.apple.TextEdit") else { return ["closed": 0] }
        let open = cuProbeServerWindows(pid: app.processIdentifier)
        var closed = 0, left: [Int] = []
        for number in Set(text.split(separator: "\n").compactMap { CGWindowID($0) }) where open.contains(number) {
            let (window, _) = await cuProbeReach(app, number)
            if let window, cuWindowNumber(window) == number, cuProbeCloseDocumentNow(window) { closed += 1 } else { left.append(Int(number)) }
        }
        if left.isEmpty { try? FileManager.default.removeItem(atPath: cuProbeLedger) }
        return ["closed": closed, "stillOpen": left]
    }

    /// TextEdit's windows on every Space, for checking what the probe would touch, and
    /// window-server windows the engine's lister does not reach.
    static func list() async -> [CUObject] {
        var rows: [CUObject] = []
        if let app = cuProbeRunningApp("com.apple.TextEdit") {
            let windows = cuProbeWindows(app)
            for window in windows {
                rows.append(["window": Int(window.number ?? 0), "title": window.title, "onScreen": window.onScreen,
                             "otherSpace": window.otherSpace, "textLength": cuProbeText(window.element).count])
            }
            for number in cuProbeServerWindows(pid: app.processIdentifier).subtracting(windows.compactMap(\.number)).sorted() {
                let (element, reachedBy) = cuWindowIsOnSomeSpace(number) ? await cuProbeReach(app, number) : (nil, "on_no_space")
                rows.append(["window": Int(number), "unlisted": true, "reachedBy": reachedBy, "title": element.flatMap { cuAttribute($0, "AXTitle") as? String } ?? "",
                             "textLength": element.map { cuProbeText($0).count } ?? -1])
            }
        }
        return rows
    }
}

/// Collects step results with timings. A step returns whether it worked and what it saw.
@MainActor final class CUProbeSteps {
    private var steps: [CUObject] = []
    var result: CUObject { ["steps": steps] }

    func record(_ name: String, _ body: () async throws -> (Bool, CUObject)) async {
        let started = cuNow()
        var row: CUObject = ["name": name]
        do {
            let (ok, detail) = try await body()
            row["ok"] = ok
            row["detail"] = detail
        } catch let fault as CUError {
            row["ok"] = false
            row["error"] = "\(fault.code): \(fault.message)"
        } catch {
            row["ok"] = false
            row["error"] = String(describing: error)
        }
        row["ms"] = cuMs(cuNow() - started)
        steps.append(row)
    }

    func app(_ bundleId: String) async -> NSRunningApplication? {
        var found: NSRunningApplication?
        await record("app_running_\(bundleId)") {
            if let running = cuProbeRunningApp(bundleId) {
                found = running
                return (true, ["pid": Int(running.processIdentifier), "active": running.isActive, "hidden": running.isHidden])
            }
            return (false, ["note": "not running; open it before the probe"])
        }
        return found
    }
}

let cuProbeLedger = "/tmp/ace-cu/locked-probe-docs.txt"
let cuProbeImageDirectory = "/tmp/ace-cu/locked-probe"

/// The longest-running regular instance: the one the person has documents open in.
func cuProbeRunningApp(_ bundleId: String) -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
        .filter { !$0.isTerminated && $0.activationPolicy == .regular }
        .min { ($0.launchDate ?? .distantFuture) < ($1.launchDate ?? .distantFuture) }
}

func cuProbeRemember(_ number: CGWindowID) {
    let line = "\(number)\n"
    if let handle = FileHandle(forWritingAtPath: cuProbeLedger) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? line.write(toFile: cuProbeLedger, atomically: true, encoding: .utf8)
    }
}

func cuProbeJSON(_ object: CUObject) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return "{}" }
    return String(decoding: data, as: UTF8.self)
}
