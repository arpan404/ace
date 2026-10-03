import ApplicationServices
import AppKit

@MainActor final class Accessibility {
    struct Entry { let element: AXUIElement; let target: Target; let pid: pid_t; let observerEpoch: UInt64 }
    private let clock: () -> UInt64
    init(clock: @escaping () -> UInt64) { self.clock = clock }
    private var entries: [String: Entry] = [:]
    private var buckets: [CFHashCode: [String]] = [:]
    private var serial: UInt64 = 0
    private var generation: UInt64 = 0
    private var observerEpoch: UInt64 = 0
    private var cached: (key: String, at: UInt64, tree: UITree)?
    private var active: Target?
    private var root: AXUIElement?
    private var pid: pid_t = 0
    private var observer: AXObserver?
    // Synchronous I/O boundary: zero-duration polling cannot park the actor's thread.
    func serviceNotifications() {
        for _ in 0..<16 { if CFRunLoopRunInMode(.defaultMode, 0, true) != .handledSource { break } }
    }
    func invalidate() { generation += 1; cached = nil }
    func reset() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        observer = nil; active = nil; root = nil; observerEpoch += 1; invalidate()
    }
    private func select(_ request: Request) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw HelperError("Accessibility permission denied", code: "permission_denied") }
        guard let target = request.target, let bundle = target.bundleId, ["app", "window"].contains(target.kind), target.bundleIds == nil, bundle.utf8.count <= 256, let allowlist = request.allowlist, allowlist.count <= 64, allowlist.contains(bundle) else { throw HelperError("Application approval required", code: "permission_denied") }
        if active == target, let cachedApp = NSRunningApplication(processIdentifier: pid), cachedApp.bundleIdentifier == bundle, !cachedApp.isTerminated, let root {
            guard axAttribute(root, kAXRoleAttribute) != nil else { throw HelperError("Accessible target is gone", code: "target_gone") }
            return root
        }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first, !app.isTerminated else { throw HelperError("Target application is gone", code: "target_gone") }
        if active == target, pid == app.processIdentifier, let root { return root }
        reset(); active = target; pid = app.processIdentifier
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.05)
        if target.kind == "window" {
            // Resolve public AX bounds against the approved CG window id; no private AX APIs.
            guard let id = target.windowId, let windows = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]], let info = windows.first,
                  let rawBounds = info[kCGWindowBounds as String] as? [String: Double], let x = rawBounds["X"], let y = rawBounds["Y"], let w = rawBounds["Width"], let h = rawBounds["Height"],
                  (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid else { throw HelperError("Target window is gone", code: "target_gone") }
            let expected = CGRect(x: x, y: y, width: w, height: h)
            let matches = axChildren(application, maximum: 128, attribute: kAXWindowsAttribute).filter { let actual = axBounds($0).rect; return abs(actual.minX - expected.minX) < 1 && abs(actual.minY - expected.minY) < 1 && abs(actual.width - expected.width) < 1 && abs(actual.height - expected.height) < 1 }
            guard matches.count == 1 else { throw HelperError("Cannot resolve an unambiguous accessible window", code: "not_supported") }
            root = matches.first
        } else { root = application }
        var created: AXObserver?
        let callback: AXObserverCallback = { _, element, notification, context in
            guard let context else { return }
            let owner = Unmanaged<Accessibility>.fromOpaque(context).takeUnretainedValue()
            MainActor.assumeIsolated { owner.changed(element, notification: notification) }
        }
        if AXObserverCreate(pid, callback, &created) == .success, let created {
            observer = created
            for name in [kAXFocusedUIElementChangedNotification, kAXValueChangedNotification, kAXWindowCreatedNotification, kAXUIElementDestroyedNotification, kAXMovedNotification, kAXResizedNotification, "AXLayoutChanged", "AXSelectedChildrenChanged"] {
                _ = AXObserverAddNotification(created, application, name as CFString, Unmanaged.passUnretained(self).toOpaque())
            }
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .defaultMode)
        }
        guard let root else { throw HelperError("No accessible root", code: "target_gone") }
        return root
    }
    private func changed(_ element: AXUIElement, notification: CFString) {
        if notification as String == kAXUIElementDestroyedNotification {
            let hash = CFHash(element)
            for ref in buckets[hash] ?? [] { if let entry = entries[ref], CFEqual(entry.element, element) { entries.removeValue(forKey: ref) } }
            let remaining = (buckets[hash] ?? []).filter { entries[$0] != nil }; if remaining.isEmpty { buckets.removeValue(forKey: hash) } else { buckets[hash] = remaining }
        }
        invalidate()
    }
    private func observeDestruction(_ element: AXUIElement) {
        if let observer { _ = AXObserverAddNotification(observer, element, kAXUIElementDestroyedNotification as CFString, Unmanaged.passUnretained(self).toOpaque()) }
    }
    private func reference(_ element: AXUIElement) throws -> String {
        let hash = CFHash(element)
        for ref in buckets[hash] ?? [] { if let entry = entries[ref], CFEqual(entry.element, element), let active { if entry.observerEpoch != observerEpoch { observeDestruction(element) }; entries[ref] = Entry(element: element, target: active, pid: pid, observerEpoch: observerEpoch); return ref } }
        if entries.count >= 4096 {
            // Only terminated applications prove all their refs dead. A timeout does not.
            let pids = Set(entries.values.map { $0.pid })
            let dead = Set(pids.filter { NSRunningApplication(processIdentifier: $0)?.isTerminated != false })
            if !dead.isEmpty { entries = entries.filter { !dead.contains($0.value.pid) }; buckets = buckets.mapValues { $0.filter { entries[$0] != nil } }.filter { !$0.value.isEmpty } }
        }
        guard entries.count < 4096, (buckets[hash]?.count ?? 0) < 32, let active else { throw HelperError("Accessibility ref capacity reached", code: "busy") }
        serial += 1; let ref = "u\(serial)"
        observeDestruction(element)
        entries[ref] = Entry(element: element, target: active, pid: pid, observerEpoch: observerEpoch); buckets[hash, default: []].append(ref)
        return ref
    }
    func tree(_ request: Request) throws -> UITree {
        let root = try select(request)
        let maxDepth = request.maxDepth ?? 8, maxNodes = request.maxNodes ?? 128
        guard (0...16).contains(maxDepth), (1...512).contains(maxNodes) else { throw HelperError("UI tree limits out of bounds", code: "bounds") }
        let now = clock()
        let key = "\(generation):\(maxDepth):\(maxNodes)"
        if let cached, cached.key == key, now - cached.at < 250_000_000 { return cached.tree }
        var remaining = maxNodes, bytes = 56 * 1024, truncated = false
        var visited = Set<String>()
        func walk(_ element: AXUIElement, depth: Int) throws -> UINode? {
            guard remaining > 0, bytes > 512, clock() - now < 250_000_000 else { truncated = true; return nil }
            let ref = try reference(element)
            guard visited.insert(ref).inserted else { return nil }
            let snapshot = axSnapshot(element, ref: ref)
            var node = snapshot.node; node.actions = axActions(element, secure: snapshot.secure)
            truncated = truncated || snapshot.truncated
            let size = try JSONEncoder().encode(node).count
            guard size <= bytes else { truncated = true; return nil }
            bytes -= size; remaining -= 1
            let children = axChildren(element, maximum: min(513, remaining + 1))
            if depth >= maxDepth { if !children.isEmpty { truncated = true }; return node }
            for child in children { if let value = try walk(child, depth: depth + 1) { node.children.append(value) } }
            return node
        }
        let node = try walk(root, depth: 0)
        let tree = UITree(nodes: node.map { [$0] } ?? [], truncated: truncated)
        cached = (key, now, tree); return tree
    }
    func find(_ request: Request) throws -> UITree {
        let root = try select(request)
        guard let query = request.query, [query.role, query.name, query.text].contains(where: { $0?.isEmpty == false }), [query.role, query.name, query.text].allSatisfy({ ($0?.count ?? 0) <= 512 }) else { throw HelperError("Search term required", code: "bounds") }
        let limit = request.limit ?? 16
        guard (1...64).contains(limit) else { throw HelperError("Search limit out of bounds", code: "bounds") }
        let started = clock()
        if let cached, started - cached.at < 250_000_000 {
            var stack = Array(cached.tree.nodes.reversed()), matches: [UINode] = []
            while let node = stack.popLast() {
                func contains(_ value: String, _ term: String?) -> Bool { term.map { value.localizedCaseInsensitiveContains($0) } ?? true }
                if contains(node.role, query.role), contains(node.name, query.name), contains([node.name, node.value ?? "", node.description ?? ""].joined(separator: " "), query.text) {
                    var result = node; result.children = []; matches.append(result)
                    if matches.count == limit { return UITree(nodes: matches, truncated: true) }
                }
                stack.append(contentsOf: node.children.reversed())
            }
            if !cached.tree.truncated { return UITree(nodes: matches, truncated: false) }
        }
        var stack: [(AXUIElement, Int)] = [(root, 0)], nodes: [UINode] = [], visited = Set<String>(), truncated = false
        var bytes = 56 * 1024
        while let (element, depth) = stack.popLast() {
            if visited.count >= 512 || clock() - started >= 250_000_000 { truncated = true; break }
            let ref = try reference(element)
            if !visited.insert(ref).inserted { continue }
            let snapshot = axSnapshot(element, ref: ref)
            var node = snapshot.node; truncated = truncated || snapshot.truncated
            func contains(_ candidate: String, _ term: String?) -> Bool { term.map { candidate.localizedCaseInsensitiveContains($0) } ?? true }
            if contains(node.role, query.role), contains(node.name, query.name), contains([node.name, node.value ?? "", node.description ?? ""].joined(separator: " "), query.text) {
                node.actions = axActions(element, secure: snapshot.secure)
                let size = try JSONEncoder().encode(node).count
                guard size <= bytes else { truncated = true; break }
                bytes -= size; nodes.append(node); if nodes.count == limit { truncated = true; break }
            }
            let available = min(512 - stack.count, 512 - visited.count)
            let children = axChildren(element, maximum: available + 1)
            if children.count > available { truncated = true }
            if depth < 16 { stack.append(contentsOf: children.prefix(available).reversed().map { ($0, depth + 1) }) } else if !children.isEmpty { truncated = true }
        }
        return UITree(nodes: nodes, truncated: truncated)
    }
    func act(_ request: Request, fallback: (UIBounds, String, String?) async throws -> Void) async throws -> Bool {
        _ = try select(request)
        guard CGPreflightScreenCaptureAccess() else { throw HelperError("Screen Recording permission denied", code: "permission_denied") }
        guard let ref = request.ref, let entry = entries[ref], entry.pid == pid, entry.target == active, axAttribute(entry.element, kAXRoleAttribute) != nil else { throw HelperError("Accessibility ref is stale", code: "target_gone") }
        if active?.kind == "window", let root, !CFEqual(root, entry.element) {
            guard let window = axAttribute(entry.element, kAXWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID(), CFEqual(window, root) else { throw HelperError("Element left the selected window", code: "target_gone") }
        }
        guard let action = request.semanticAction, ["press", "focus", "setValue", "scroll", "expand", "select"].contains(action), (request.value?.utf16.count ?? 0) <= 4096 else { throw HelperError("Unsupported semantic action", code: "not_supported") }
        let snapshot = axMetadata(entry.element, ref: ref)
        let node = snapshot.node
        if node.states.contains("disabled") { throw HelperError("Element is disabled", code: "bounds") }
        if snapshot.secure { throw HelperError("Secure fields refuse semantic input", code: "permission_denied") }
        if (action == "focus" && node.states.contains("focused")) || (action == "select" && node.states.contains("selected")) || (action == "expand" && node.states.contains("expanded")) { return false }
        if action == "setValue" && request.value == nil { throw HelperError("setValue requires a value", code: "bounds") }
        let result: AXError
        switch action {
        case "press": result = AXUIElementPerformAction(entry.element, kAXPressAction as CFString)
        case "scroll": result = AXUIElementPerformAction(entry.element, (request.value == "up" ? "AXScrollUpByPage" : "AXScrollDownByPage") as CFString)
        default:
            let attribute = ["focus": kAXFocusedAttribute, "setValue": kAXValueAttribute, "select": kAXSelectedAttribute, "expand": "AXExpanded"][action] ?? ""
            let value: CFTypeRef = action == "setValue" ? (request.value ?? "") as CFString : kCFBooleanTrue
            result = AXUIElementSetAttributeValue(entry.element, attribute as CFString, value)
        }
        if result == .success { invalidate(); return false }
        guard result == .actionUnsupported || result == .attributeUnsupported || result == .notImplemented else { throw HelperError("Accessibility action failed (\(result.rawValue))", code: result == .invalidUIElement ? "target_gone" : "internal") }
        guard node.bounds.w > 0, node.bounds.h > 0, !node.states.contains("offscreen") else { throw HelperError("Element has no usable bounds", code: "bounds") }
        try await fallback(node.bounds, action, request.value); invalidate(); return true
    }
}
