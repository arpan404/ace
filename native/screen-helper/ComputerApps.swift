import AppKit

struct CUInstalledApp {
    let name: String
    let bundleId: String
    let url: URL
    /// Every name the app goes by: display name, bundle name and `.app` file name.
    var names: [String] = []

    func matches(exactly wanted: String) -> Bool {
        bundleId.lowercased() == wanted || name.lowercased() == wanted || names.contains { $0.lowercased() == wanted }
    }

    func matches(partially wanted: String) -> Bool {
        name.lowercased().contains(wanted) || names.contains { $0.lowercased().contains(wanted) }
    }
}

/// The names an app bundle answers to, deduplicated, display name first.
func cuAppNames(displayName: String?, bundleName: String?, fileName: String) -> [String] {
    let file = fileName.hasSuffix(".app") ? String(fileName.dropLast(4)) : fileName
    var names: [String] = []
    for candidate in [displayName, bundleName, file] {
        guard let candidate, !candidate.isEmpty, !names.contains(where: { $0.caseInsensitiveCompare(candidate) == .orderedSame }) else { continue }
        names.append(candidate)
    }
    return names
}

/// Installed apps from the standard folders (and one level of subfolders, such as
/// "Adobe Photoshop 2025/" or "Utilities/"), cached briefly. Bundle ids not found there are
/// looked up through LaunchServices.
@MainActor final class CUAppCatalog {
    private var cached: [CUInstalledApp] = []
    private var cachedAt: UInt64 = 0

    func installed() -> [CUInstalledApp] {
        let now = cuNow()
        if !cached.isEmpty, now - cachedAt < 60_000_000_000 { return cached }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let roots = ["/Applications", "/System/Applications", "\(home)/Applications", "/System/Library/CoreServices/Applications", "/System/Library/CoreServices/Finder.app"]
        var seen = Set<String>()
        var apps: [CUInstalledApp] = []
        for root in roots {
            for url in cuAppBundles(in: URL(fileURLWithPath: root), depth: 1) {
                guard let app = cuInstalledApp(at: url), !seen.contains(app.bundleId) else { continue }
                seen.insert(app.bundleId)
                apps.append(app)
            }
        }
        cached = apps
        cachedAt = now
        return apps
    }

    /// Regular apps, and accessory (menu-bar) apps that have a window, whose process is alive.
    /// LaunchServices can keep a record of an app that already exited, so the process is checked.
    func running() -> [NSRunningApplication] {
        let all = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier != nil && !$0.isTerminated }
        let accessory = all.contains { $0.activationPolicy == .accessory }
        let windowed = accessory ? cuPidsWithWindows() : []
        return all.filter { app in
            let wanted = app.activationPolicy == .regular || (app.activationPolicy == .accessory && windowed.contains(app.processIdentifier))
            return wanted && kill(app.processIdentifier, 0) == 0
        }
    }

    /// Match by bundle id or name, exact first, then a unique partial name match.
    func resolve(_ query: String) throws -> (running: NSRunningApplication?, installed: CUInstalledApp?) {
        let wanted = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !wanted.isEmpty else { throw CUError("app_not_found", "Name an app, e.g. \"Calculator\" or \"com.apple.TextEdit\".") }
        func named(_ app: NSRunningApplication) -> Bool { app.bundleIdentifier?.lowercased() == wanted || app.localizedName?.lowercased() == wanted }
        // Regular apps first: finding accessory apps with windows means listing every window.
        if let app = NSWorkspace.shared.runningApplications.first(where: { $0.activationPolicy == .regular && !$0.isTerminated && named($0) }),
           kill(app.processIdentifier, 0) == 0 {
            return (app, nil)
        }
        let running = running()
        if let app = running.first(where: named) { return (app, nil) }
        let installed = installed()
        if let app = installed.first(where: { $0.matches(exactly: wanted) }) ?? launchServicesApp(wanted) {
            return (running.first { $0.bundleIdentifier == app.bundleId }, app)
        }
        var partial: [(String, String)] = running.compactMap { app in
            guard let name = app.localizedName, let id = app.bundleIdentifier, name.lowercased().contains(wanted) else { return nil }
            return (name, id)
        }
        for app in installed where app.matches(partially: wanted) && !partial.contains(where: { $0.1 == app.bundleId }) {
            partial.append((app.name, app.bundleId))
        }
        if partial.count == 1 { return try resolve(partial[0].1) }
        if partial.isEmpty { throw CUError("app_not_found", "No installed app matches \"\(query)\". Call screen_apps with a shorter query to see what is installed.") }
        let listed = partial.prefix(12).map { "\($0.0) (\($0.1))" }.joined(separator: ", ")
        throw CUError("app_ambiguous", "\"\(query)\" matches several apps: \(listed). Pass the exact name or bundle id.")
    }

    /// Apps installed anywhere LaunchServices knows, found by bundle id.
    private func launchServicesApp(_ wanted: String) -> CUInstalledApp? {
        guard wanted.contains("."), !wanted.contains(" "), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: wanted) else { return nil }
        return cuInstalledApp(at: url)
    }

    /// Launches without activating: the person's frontmost app keeps focus.
    func launch(_ app: CUInstalledApp) async throws -> NSRunningApplication {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.promptsUserIfNeeded = false
        do {
            let running = try await NSWorkspace.shared.openApplication(at: app.url, configuration: configuration)
            let started = cuNow()
            while !running.isFinishedLaunching, cuNow() - started < 5_000_000_000 { try? await Task.sleep(nanoseconds: 25_000_000) }
            return running
        } catch {
            throw CUError("launch_failed", "\(app.name) could not be opened: \(error.localizedDescription)")
        }
    }
}

/// `.app` bundles in a folder, descending `depth` levels into plain subfolders.
func cuAppBundles(in folder: URL, depth: Int) -> [URL] {
    if folder.pathExtension == "app" { return [folder] }
    guard let entries = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { return [] }
    var found: [URL] = []
    for entry in entries {
        if entry.pathExtension == "app" { found.append(entry); continue }
        guard depth > 0, (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { continue }
        found += cuAppBundles(in: entry, depth: depth - 1)
    }
    return found
}

func cuInstalledApp(at url: URL) -> CUInstalledApp? {
    guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier else { return nil }
    let names = cuAppNames(displayName: bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String,
                           bundleName: bundle.object(forInfoDictionaryKey: "CFBundleName") as? String, fileName: url.lastPathComponent)
    return CUInstalledApp(name: names.first ?? id, bundleId: id, url: url, names: names)
}

/// Processes that own a normal-layer window on any Space.
func cuPidsWithWindows() -> Set<pid_t> {
    let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var pids = Set<pid_t>()
    for row in info where (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
        guard let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, !pids.contains(pid),
              ((row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0,
              let bounds = row[kCGWindowBounds as String] as? [String: Any],
              ((bounds["Width"] as? NSNumber)?.doubleValue ?? 0) >= 60, ((bounds["Height"] as? NSNumber)?.doubleValue ?? 0) >= 60 else { continue }
        pids.insert(pid)
    }
    return pids
}
