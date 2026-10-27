import SwiftUI

/// What ships inside the app and its licence. The interface uses Apple's system fonts (SF Pro,
/// SF Mono). The only third-party images are the providers' marks (LobeHub Icons, and OpenAI's
/// Blossom from its brand kit). The JavaScript bridge bundles ace's own packages, Zod and the
/// shared HTML renderer's parse5/entities dependencies; answers' math is typeset with KaTeX.
struct LicencesView: View {
    private struct Entry: Identifiable {
        let name: String
        let licence: String
        let notice: String
        var id: String { name }
    }
    private let entries = [
        Entry(name: "ace", licence: "Apache License 2.0",
              notice: "Copyright ace contributors. Licensed under the Apache License, Version 2.0. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0"),
        Entry(name: "Zod", licence: "MIT",
              notice: "Copyright (c) 2025 Colin McDonnell. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."),
        Entry(name: "LobeHub Icons", licence: "MIT",
              notice: "Provider marks from @lobehub/icons-static-svg. The marks remain the trademarks of their owners and identify each provider's own product. Copyright (c) 2023 LobeHub. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."),
        Entry(name: "OpenAI Blossom", licence: "Trademark",
              notice: "OpenAI's trademark, unmodified from OpenAI's brand kit, shown only to identify OpenAI's own products. It is not licensed under ace's licence."),
        Entry(name: "parse5", licence: "MIT", notice: Self.bundledNotice("parse5-license")),
        Entry(name: "entities", licence: "BSD 2-Clause", notice: Self.bundledNotice("entities-license")),
        Entry(name: "KaTeX", licence: "MIT", notice: Self.bundledNotice("katex-license")),
    ]
    private static func bundledNotice(_ name: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: "txt"), let text = try? String(contentsOf: url, encoding: .utf8) else { return "See \(name).txt in the app bundle." }
        return text
    }
    var body: some View {
        List(entries) { entry in
            Section {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                    Text(entry.name).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                    Text(entry.licence).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                    Text(entry.notice).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                .padding(.vertical, AceTheme.Spacing.sm)
                .accessibilityElement(children: .combine)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle("Licences").navigationBarTitleDisplayMode(.inline)
    }
}
