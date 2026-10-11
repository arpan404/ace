import ApplicationServices
import AppKit

@MainActor final class Accessibility {
    struct Entry { let element: AXUIElement; let target: Target; let pid: pid_t; let observerEpoch: UInt64 }
    var dispatched = false
    let resolver: WindowResolver
    private let clock: () -> UInt64
    init(clock: @escaping () -> UInt64, resolver: WindowResolver? = nil) { self.clock = clock; self.resolver = resolver ?? WindowResolver() }
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
        let timeout: Float = request.op == "ui.tree" || request.op == "ui.find" ? 0.2 : 0.05
        if let root { AXUIElementSetMessagingTimeout(root, timeout) }
        guard let target = request.target, let bundle = target.bundleId, ["app", "window"].contains(target.kind), target.bundleIds == nil, bundle.utf8.count <= 256, let allowlist = request.allowlist, allowlist.count <= 64, allowlist.contains(bundle) else { throw HelperError("Application approval required", code: "permission_denied") }
        if active == target, let cachedApp = NSRunningApplication(processIdentifier: pid), cachedApp.bundleIdentifier == bundle, !cachedApp.isTerminated, let root {
            guard axAttribute(root, kAXRoleAttribute) != nil else { throw HelperError("Accessible target is gone", code: "target_gone") }
            if let id = target.windowId { return try resolver.resolve(id: id, pid: pid) }
            return root
        }
        let app = try targetApplication(target)
        if active == target, pid == app.processIdentifier, let root { return root }
        reset(); active = target; pid = app.processIdentifier
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, request.op == "ui.tree" || request.op == "ui.find" ? 0.2 : 0.05)
        if target.kind == "window" {
            guard let id = target.windowId else { throw HelperError("Window ID required", code: "bounds") }
            root = try resolver.resolve(id: id, pid: pid)
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
        AXUIElementSetMessagingTimeout(root, timeout)
        return root
    }
    private func changed(_ element: AXUIElement, notification: CFString) {
        if [kAXWindowCreatedNotification, kAXUIElementDestroyedNotification, kAXMovedNotification, kAXResizedNotification, kAXFocusedUIElementChangedNotification, "AXLayoutChanged", "AXSelectedChildrenChanged"].contains(notification as String) { resolver.invalidate() }
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
            var node = snapshot.node; node.secondaryActions = axActionNames(element); node.actions = axActions(element, secure: snapshot.secure, native: node.secondaryActions)
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
                node.secondaryActions = axActionNames(element); node.actions = axActions(element, secure: snapshot.secure, native: node.secondaryActions)
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
        guard let action = request.semanticAction, ["press", "focus", "setValue", "scroll", "expand", "select", "performSecondaryAction", "selectText"].contains(action), (request.value?.utf16.count ?? 0) <= 4096 else { throw HelperError("Unsupported semantic action", code: "not_supported") }
        let snapshot = axMetadata(entry.element, ref: ref)
        try requireMenuConsent(mode: request.mode, action: action, role: snapshot.node.role, secondary: request.name)
        let node = snapshot.node
        if node.states.contains("disabled") { throw HelperError("Element is disabled", code: "bounds") }
        if ["setValue", "selectText"].contains(action) { try TextDestination(element: entry.element, security: textSecurity(entry.element)).requireConsent(request.secureInputAllowed == true) }
        if snapshot.secure && request.secureInputAllowed != true { throw HelperError("Secure fields require session consent", code: "secure_input_required") }
        if (action == "focus" && node.states.contains("focused")) || (action == "select" && node.states.contains("selected")) || (action == "expand" && node.states.contains("expanded")) { return false }
        if action == "setValue" && request.value == nil && request.booleanValue == nil { throw HelperError("setValue requires a value", code: "bounds") }
        if action == "focus", node.role == "AXWindow" {
            guard request.mode == "foreground" else { throw HelperError("AXRaise requires foreground mode", code: "foreground_required") }
            guard AXUIElementPerformAction(entry.element, kAXRaiseAction as CFString) == .success else { throw HelperError("Cannot raise window", code: "not_supported") }
            invalidate(); return false
        }
        if action == "focus", request.mode != "foreground", NSWorkspace.shared.frontmostApplication?.processIdentifier == entry.pid { throw HelperError("Background focus cannot change the human's focused field", code: "foreground_required") }
        let result: AXError
        dispatched = true
        switch action {
        case "performSecondaryAction":
            guard let name = request.name, axActionNames(entry.element).contains(name) else { throw HelperError("Action is not advertised by this element", code: "not_supported") }
            if name == kAXRaiseAction && request.mode != "foreground" { throw HelperError("AXRaise requires foreground mode", code: "foreground_required") }
            result = AXUIElementPerformAction(entry.element, name as CFString)
        case "selectText":
            if let range = request.range {
                guard range.location >= 0, range.length >= 0, range.location <= Int.max - range.length else { throw HelperError("Invalid text range", code: "bounds") }
                var value = CFRange(location: range.location, length: range.length)
                guard let axRange = AXValueCreate(.cfRange, &value) else { throw HelperError("Cannot encode text range", code: "bounds") }
                result = AXUIElementSetAttributeValue(entry.element, kAXSelectedTextRangeAttribute as CFString, axRange)
            } else {
                guard let value = request.value else { throw HelperError("selectText requires value or range", code: "bounds") }
                result = AXUIElementSetAttributeValue(entry.element, kAXSelectedTextAttribute as CFString, value as CFString)
            }
        case "press": result = AXUIElementPerformAction(entry.element, kAXPressAction as CFString)
        case "scroll":
            let name = request.scrollValue.map { abs($0.dx) > abs($0.dy) ? ($0.dx > 0 ? "AXScrollRightByPage" : "AXScrollLeftByPage") : ($0.dy > 0 ? "AXScrollUpByPage" : "AXScrollDownByPage") } ?? (request.value == "up" ? "AXScrollUpByPage" : "AXScrollDownByPage")
            result = AXUIElementPerformAction(entry.element, name as CFString)
        default:
            let attribute = ["focus": kAXFocusedAttribute, "setValue": kAXValueAttribute, "select": kAXSelectedAttribute, "expand": "AXExpanded"][action] ?? ""
            let value: CFTypeRef = action == "setValue" && request.booleanValue == nil ? (request.value ?? "") as CFString : (request.booleanValue == false ? kCFBooleanFalse : kCFBooleanTrue)
            result = AXUIElementSetAttributeValue(entry.element, attribute as CFString, value)
        }
        if result == .success { invalidate(); return false }
        guard result == .actionUnsupported || result == .attributeUnsupported || result == .notImplemented else { throw HelperError("Accessibility action failed (\(result.rawValue))", code: result == .invalidUIElement ? "target_gone" : "internal") }
        guard !["performSecondaryAction", "selectText", "focus", "select", "expand"].contains(action) else { throw HelperError("No safe semantic fallback", code: "not_supported") }
        guard node.bounds.w > 0, node.bounds.h > 0, !node.states.contains("offscreen") else { throw HelperError("Element has no usable bounds", code: "bounds") }
        try await fallback(node.bounds, action, request.value); invalidate(); return true
    }
    /// Event-driven invalidation plus a short quiet interval; no timer while idle.
    func settle(_ request: Request) async throws -> UITree {
        invalidate()
        return try await settledObservation(wait: { try await Task.sleep(nanoseconds: 50_000_000) },
            revision: { self.serviceNotifications(); return self.generation },
            observe: { self.invalidate(); return try self.tree(request) })
    }

}
