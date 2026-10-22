import AppKit
import ApplicationServices

/// Set ACE_CU_TIMINGS=1 to get per-phase timings in observations (for benchmarking).
let cuTimingsEnabled = ProcessInfo.processInfo.environment["ACE_CU_TIMINGS"] != nil

func cuMs(_ nanoseconds: UInt64) -> Double { (Double(nanoseconds) / 100_000).rounded() / 10 }

extension CUAppSession {
    /// The observation the model gets: app, windows, the chosen window's outline (unless
    /// `outline` is false), focus, menu bar and optionally a screenshot tagged with ids.
    func observation(windows: [CUWindow], screenshot: Bool, outline: Bool, marks: Bool, deadline: UInt64) async -> CUObject {
        var tree = CUTree()
        let started = cuNow()
        // The app just failed to answer: every further AX call would wait out its timeout too.
        if outline, !notResponding {
            tree = await walkUnlessUnchanged(deadline: deadline)
            if chromium, !chromiumWarmed {
                chromiumWarmed = true
                // Chromium builds its tree a moment after first being asked for; look again, a
                // few times within about two seconds, until the web content shows up.
                let until = cuNow() + 2_000_000_000
                while cuChromiumTreePending(tree.nodes), window != nil, !tree.notResponding, cuNow() < until {
                    await settler.settle(minimumMs: 250, quietMs: 150, maximumMs: 700)
                    tree = walk(deadline: max(deadline, cuNow() + 1_500_000_000))
                }
            }
        }
        let walked = cuNow()
        var result = describe(windows: windows, tree: tree)
        let described = cuNow()
        // Without a fresh walk the ids on screen could name elements that changed; no tags then.
        if screenshot { await attachScreenshot(to: &result, marks: marks && outline) }
        if cuTimingsEnabled {
            result["timings"] = ["walkMs": cuMs(walked - started), "events": Int(settler.events), "visited": tree.visited, "fetchMs": cuMs(tree.fetchNs), "actionsMs": cuMs(tree.actionNs), "describeMs": cuMs(described - walked), "screenshotMs": cuMs(cuNow() - described)]
        }
        return result
    }

    private func describe(windows: [CUWindow], tree: CUTree) -> CUObject {
        var result: CUObject = [
            "app": ["name": name, "bundleId": app.bundleIdentifier ?? "", "pid": Int(pid), "active": app.isActive, "hidden": app.isHidden],
            "windows": windows.map { item -> CUObject in
                var entry: CUObject = ["index": item.index, "title": item.title, "onScreen": item.onScreen]
                if item.minimized { entry["minimized"] = true }
                if item.otherSpace { entry["otherSpace"] = true }
                if let window, CFEqual(item.element, window.element) { entry["current"] = true }
                return entry
            },
            "nodes": tree.nodes.map { $0.json(origin: .zero) },
            "truncated": tree.truncated,
            "screenLocked": cuScreenLocked(),
        ]
        if notResponding || tree.notResponding {
            result["notResponding"] = true
            return result
        }
        result["menuBar"] = menuBarTitles()
        if let window { result["window"] = ["title": window.title, "width": Int(window.frame.width), "height": Int(window.frame.height), "onScreen": window.onScreen] }
        if let focused = focusedSummary() { result["focused"] = focused }
        return result
    }

    private func focusedSummary() -> CUObject? {
        guard let focused = cuElementAttribute(element, "AXFocusedUIElement") else { return nil }
        let attributes = cuFetchStatus(focused, ["AXRole", "AXRoleDescription", "AXTitle", "AXDescription", "AXSelectedText"]).0
        let role = attributes["AXRole"] as? String ?? ""
        var entry: CUObject = ["role": attributes["AXRoleDescription"] as? String ?? role]
        if let id = registry.existingId(for: focused) { entry["id"] = id }
        if let title = cuClip((attributes["AXTitle"] as? String) ?? (attributes["AXDescription"] as? String), 120) { entry["name"] = title }
        if role != "AXSecureTextField", let selected = cuClip(attributes["AXSelectedText"] as? String, 500) { entry["selectedText"] = selected }
        return entry
    }

    private func attachScreenshot(to result: inout CUObject, marks: Bool) async {
        guard let window, let number = window.number else {
            result["screenshotError"] = "\(name) has no window to capture."
            return
        }
        if window.minimized {
            result["screenshotError"] = "The window is minimized, so it can't be captured. Use the outline, or ask the person to restore it."
            return
        }
        do {
            let nodes = lastNodes, frame = window.frame
            let image = try await cuCaptureWindow(number, frame: frame, marks: { scale in marks ? cuMarks(nodes: nodes, window: frame, scale: scale) : [] })
            recordScreenshot(scale: image.scale)
            result["screenshot"] = ["jpeg": image.jpeg.base64EncodedString(), "width": image.width, "height": image.height]
        } catch {
            // The outline is still useful; say why there is no picture.
            let fault = error as? CUError
            result["screenshotError"] = fault?.message ?? "macOS would not capture this window (\((error as NSError).localizedDescription))."
        }
    }
}
