import AppKit

struct CUInstalledApp {
    let name: String
    let bundleId: String
    let url: URL
}

/// Installed apps from the standard folders, cached briefly.
@MainActor final class CUAppCatalog {
    private var cached: [CUInstalledApp] = []
    private var cachedAt: UInt64 = 0

    func installed() -> [CUInstalledApp] {
        let now = DispatchTime.now().uptimeNanoseconds
        if !cached.isEmpty, now - cachedAt < 60_000_000_000 { return cached }
        let manager = FileManager.default
        let home = manager.homeDirectoryForCurrentUser.path
        let roots = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", "\(home)/Applications", "/System/Library/CoreServices/Applications"]
        var seen = Set<String>()
        var apps: [CUInstalledApp] = []
        for root in roots {
            guard let entries = try? manager.contentsOfDirectory(atPath: root) else { continue }
            for entry in entries where entry.hasSuffix(".app") {
                let url = URL(fileURLWithPath: root).appendingPathComponent(entry)
                guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier, !seen.contains(id) else { continue }
                seen.insert(id)
                let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
                    ?? String(entry.dropLast(4))
                apps.append(CUInstalledApp(name: name, bundleId: id, url: url))
            }
        }
        cached = apps
        cachedAt = now
        return apps
    }

    /// Regular apps whose process is alive. LaunchServices can keep a record of an app that
    /// already exited, so the process itself is checked.
    func running() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && $0.bundleIdentifier != nil && !$0.isTerminated && kill($0.processIdentifier, 0) == 0
        }
    }

    /// Match by bundle id or name, exact first, then a unique partial name match.
    func resolve(_ query: String) throws -> (running: NSRunningApplication?, installed: CUInstalledApp?) {
        let wanted = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !wanted.isEmpty else { throw CUError("app_not_found", "Name an app, e.g. \"Calculator\" or \"com.apple.TextEdit\".") }
        let running = running()
        if let app = running.first(where: { $0.bundleIdentifier?.lowercased() == wanted || $0.localizedName?.lowercased() == wanted }) {
            return (app, nil)
        }
        let installed = installed()
        if let app = installed.first(where: { $0.bundleId.lowercased() == wanted || $0.name.lowercased() == wanted }) {
            return (running.first { $0.bundleIdentifier == app.bundleId }, app)
        }
        var partial: [(String, String)] = running.compactMap { app in
            guard let name = app.localizedName, let id = app.bundleIdentifier, name.lowercased().contains(wanted) else { return nil }
            return (name, id)
        }
        for app in installed where app.name.lowercased().contains(wanted) && !partial.contains(where: { $0.1 == app.bundleId }) {
            partial.append((app.name, app.bundleId))
        }
        if partial.count == 1 { return try resolve(partial[0].1) }
        if partial.isEmpty { throw CUError("app_not_found", "No installed app matches \"\(query)\". Call screen_apps with a shorter query to see what is installed.") }
        let listed = partial.prefix(12).map { "\($0.0) (\($0.1))" }.joined(separator: ", ")
        throw CUError("app_ambiguous", "\"\(query)\" matches several apps: \(listed). Pass the exact name or bundle id.")
    }

    /// Launches without activating: the person's frontmost app keeps focus.
    func launch(_ app: CUInstalledApp) async throws -> NSRunningApplication {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.promptsUserIfNeeded = false
        do {
            let running = try await NSWorkspace.shared.openApplication(at: app.url, configuration: configuration)
            for _ in 0..<100 where !running.isFinishedLaunching { try? await Task.sleep(nanoseconds: 50_000_000) }
            return running
        } catch {
            throw CUError("launch_failed", "\(app.name) could not be opened: \(error.localizedDescription)")
        }
    }
}
