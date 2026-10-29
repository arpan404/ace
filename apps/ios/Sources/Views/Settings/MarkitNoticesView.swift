import SwiftUI

/// markit's own licence notices, as its Swift package ships them (`Licenses` in its resource
/// bundle, copied from packages/markit by `bun run markit`): its third-party notices, the
/// licences of its Rust dependencies, the math font and the LaTeX tables, each readable in full.
struct MarkitNoticesView: View {
    private struct Notice: Identifiable {
        let name: String
        let url: URL
        var id: String { name }
    }
    @State private var notices: [Notice] = []

    /// The `Licenses` folder inside markit's resource bundle, wherever the build placed it.
    static var folder: URL? {
        let bundles = (Bundle.main.urls(forResourcesWithExtension: "bundle", subdirectory: nil) ?? [])
            + [Bundle.main.bundleURL]
        return bundles.lazy
            .map { $0.appendingPathComponent("Licenses", isDirectory: true) }
            .first { FileManager.default.fileExists(atPath: $0.appendingPathComponent("THIRD_PARTY_NOTICES.md").path) }
    }

    /// markit's summary of what it bundles, shown on the Licences list itself.
    static var summary: String {
        guard let folder, let text = try? String(contentsOf: folder.appendingPathComponent("THIRD_PARTY_NOTICES.md"), encoding: .utf8) else {
            return "See markit's Licenses folder in the app bundle."
        }
        return text
    }

    var body: some View {
        List(notices) { notice in
            NavigationLink(notice.name) { page(notice) }
        }
        .insetGroupedList()
        .navigationTitle("markit notices").navigationBarTitleDisplayMode(.inline)
        .task { notices = Self.read() }
    }

    private func page(_ notice: Notice) -> some View {
        ScrollView {
            Text((try? String(contentsOf: notice.url, encoding: .utf8)) ?? "This notice couldn't be read.")
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(AceTheme.Spacing.xl)
        }
        .navigationTitle(notice.name).navigationBarTitleDisplayMode(.inline)
    }

    private static func read() -> [Notice] {
        guard let folder, let walk = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey]) else { return [] }
        let base = folder.standardizedFileURL.path + "/"
        var found: [Notice] = []
        for case let url as URL in walk where (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            let path = url.standardizedFileURL.path
            found.append(Notice(name: path.hasPrefix(base) ? String(path.dropFirst(base.count)) : url.lastPathComponent, url: url))
        }
        return found.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
}
