import Foundation

/// Conservative transport filter. The daemon still applies its canonical findLines
/// formatter. Unicode queries/lines pass through because Swift and JS Unicode case
/// tables can differ. An optimization must never discard a possible match.
struct CUOutlineSearchIndex {
    private let nodes: [CUNode]
    private let lines: [NSString?]

    init(nodes: [CUNode]) {
        self.nodes = nodes
        lines = nodes.map { node in
            let line = cuSearchLine(node)
            return line.utf8.allSatisfy({ $0 < 128 }) ? line.lowercased() as NSString : nil
        }
    }

    static func supports(_ query: String) -> Bool {
        !query.isEmpty && query.utf8.count <= 800 && query.utf8.allSatisfy({ $0 < 128 })
    }

    func candidates(query: String) -> [CUNode] {
        guard Self.supports(query) else { return nodes }
        let needle = query.lowercased()
        var ancestors: [Int] = []
        var shown = Set<Int>()
        for (index, node) in nodes.enumerated() {
            while let parent = ancestors.last, nodes[parent].depth >= node.depth { ancestors.removeLast() }
            if lines[index].map({ $0.range(of: needle, options: .literal).location != NSNotFound }) ?? true {
                shown.insert(index)
                shown.formUnion(ancestors)
            }
            ancestors.append(index)
        }
        return nodes.enumerated().compactMap { shown.contains($0.offset) ? $0.element : nil }
    }
}

/// ASCII spelling of the wire outline, including labels and escaped text. This is
/// only a prefilter; the daemon remains the authority for match counts and rendering.
/// Only findFormat=1 opts in. A daemon changing its spelling must advance that token,
/// so an older helper falls back to the complete tree instead of discarding matches.
private func cuSearchLine(_ node: CUNode) -> String {
    func escape(_ text: String) -> String {
        guard text.utf8.contains(where: { $0 == 92 || $0 == 10 || $0 == 9 }) else { return text }
        return text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\t", with: "\\t")
    }
    var line = "\(node.id) \(node.role)"
    if !node.flags.isEmpty { line += " (\(node.flags.joined(separator: ", ")))" }
    if let name = node.name, !name.isEmpty { line += " \(escape(name))" }
    var extras: [String] = []
    if let value = node.value { extras.append("Value: \(escape(value))") }
    if let detail = node.detail, !detail.isEmpty { extras.append("Description: \(escape(detail))") }
    if let placeholder = node.placeholder, !placeholder.isEmpty { extras.append("Placeholder: \(escape(placeholder))") }
    if let url = node.url, !url.isEmpty { extras.append("URL: \(url)") }
    if !node.actions.isEmpty { extras.append("Actions: \(node.actions.joined(separator: ", "))") }
    return extras.isEmpty ? line : line + ", " + extras.joined(separator: ", ")
}
