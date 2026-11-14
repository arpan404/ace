import Foundation

/// Which fenced code blocks in an answer draw as diagrams: Mermaid, as the web draws them.
enum DiagramFence {
    static func draws(_ language: String) -> Bool {
        language.trimmingCharacters(in: .whitespaces).lowercased() == "mermaid"
    }
}

/// Diagrams drawn for answers, by source and appearance. Drawing one is heavy (a web view runs
/// Mermaid), so each is drawn once and kept, the most recent `maxKept`; a transcript scrolled back
/// over them shows what was kept. Diagrams are drawn one at a time, in the order asked; one whose
/// every asker went away (scrolled past) before its turn is skipped, and is drawn when asked
/// again. A source that couldn't be drawn isn't tried again: its code stays.
/// `Drawn` crosses tasks (each drawing is shared by its askers), so it is `Sendable`: a
/// main-actor class, as a drawing is.
@MainActor final class DiagramRenders<Drawn: AnyObject & Sendable> {
    typealias Draw = @MainActor (_ source: String, _ dark: Bool) async -> Drawn?

    private let draw: Draw
    private let maxKept: Int
    private var kept: [String: Drawn] = [:]
    private var keptOrder: [String] = []
    private var failed: Set<String> = []
    private var failedOrder: [String] = []
    /// Drawings asked for and not finished, each shared by every asker.
    private var pending: [String: Task<Drawn?, Never>] = [:]
    /// How many askers still wait for each pending drawing.
    private var waiting: [String: Int] = [:]
    /// The last drawing queued: the next one starts after it.
    private var tail: Task<Void, Never>?

    init(maxKept: Int = 8, draw: @escaping Draw) {
        self.maxKept = maxKept
        self.draw = draw
    }

    /// What was drawn for this source and appearance, without drawing it.
    func kept(_ source: String, dark: Bool) -> Drawn? { kept[Self.key(source, dark)] }

    /// The drawing, drawn now if it isn't kept; nil when it can't be drawn or the asker left.
    func drawn(_ source: String, dark: Bool) async -> Drawn? {
        let key = Self.key(source, dark)
        if let hit = kept[key] { return hit }
        if failed.contains(key) { return nil }
        waiting[key, default: 0] += 1
        let task = pending[key] ?? queue(key, source: source, dark: dark)
        return await withTaskCancellationHandler {
            let drawn = await task.value
            return Task.isCancelled ? nil : drawn
        } onCancel: {
            Task { @MainActor [weak self] in self?.leave(key) }
        }
    }

    private func queue(_ key: String, source: String, dark: Bool) -> Task<Drawn?, Never> {
        let previous = tail
        let task = Task<Drawn?, Never> { @MainActor [weak self] in
            await previous?.value
            guard let self else { return nil }
            defer { self.pending[key] = nil; self.waiting[key] = nil }
            guard (self.waiting[key] ?? 0) > 0 else { return nil }
            let drawn = await self.draw(source, dark)
            if let drawn { self.keep(drawn, for: key) } else { self.fail(key) }
            return drawn
        }
        pending[key] = task
        tail = Task { _ = await task.value }
        return task
    }

    private func leave(_ key: String) {
        guard let count = waiting[key] else { return }
        waiting[key] = count - 1
    }

    private func keep(_ drawn: Drawn, for key: String) {
        if kept.updateValue(drawn, forKey: key) == nil { keptOrder.append(key) }
        while keptOrder.count > maxKept { kept[keptOrder.removeFirst()] = nil }
    }

    private func fail(_ key: String) {
        if failed.insert(key).inserted { failedOrder.append(key) }
        while failedOrder.count > 64 { failed.remove(failedOrder.removeFirst()) }
    }

    private static func key(_ source: String, _ dark: Bool) -> String {
        (dark ? "dark|" : "light|") + contentKey(source)
    }
}
