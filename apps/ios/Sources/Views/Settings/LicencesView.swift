import SwiftUI

/// What ships inside the app and its licence. The interface uses Apple's system fonts (SF Pro,
/// SF Mono). The only third-party images are the providers' marks (LobeHub Icons, and OpenAI's
/// Blossom from its brand kit) and the Git hosts' marks (GitLab, Gitea, Bitbucket, GitBucket,
/// Forgejo), each credited from NOTICE. The JavaScript bridge bundles ace's own packages, Zod and the
/// shared HTML renderer's parse5/entities dependencies. Markdown, math and code colours are drawn
/// by markit, whose own notices (its Rust dependencies, the math font) ship in its bundle.
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
        Entry(name: "GitLab tanuki", licence: "MIT",
              notice: "GitLab's mark, from GitLab's own app (gitlab-org/gitlab, app/views/shared/_logo.svg). The mark remains its owner's trademark and identifies its own product. Copyright (c) 2011-present GitLab Inc. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."),
        Entry(name: "Gitea teacup", licence: "MIT",
              notice: "Gitea's mark, from go-gitea/gitea (assets/logo.svg). The mark remains its owner's trademark and identifies its own product. Copyright (c) 2016 The Gitea Authors. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."),
        Entry(name: "Bitbucket mark", licence: "Apache License 2.0",
              notice: "Bitbucket's mark, from Atlassian's @atlaskit/logo 23.3.1 (bitbucket/icon). The mark remains its owner's trademark and identifies its own product. Copyright 2019 Atlassian Pty Ltd. Licensed under the Apache License, Version 2.0. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0"),
        Entry(name: "GitBucket mark", licence: "Apache License 2.0",
              notice: "GitBucket's mark, from gitbucket/gitbucket (src/main/webapp/assets/common/images/gitbucket.svg). The mark remains its owner's trademark and identifies its own product. Copyright the GitBucket authors. Licensed under the Apache License, Version 2.0. You may obtain a copy of the License at https://www.apache.org/licenses/LICENSE-2.0"),
        Entry(name: "Forgejo logo", licence: "CC BY-SA 4.0",
              notice: "Forgejo's logo by Caesar Schinas (https://caesarschinas.com/), from Forgejo's branding (codeberg.org/forgejo/governance, branding/logo/forgejo.svg). The mark remains its owner's trademark and identifies its own product. Licensed under the Creative Commons Attribution-ShareAlike 4.0 International licence, https://creativecommons.org/licenses/by-sa/4.0/. Changed for ace: its strokes were converted to filled outlines, unchanged in shape. This adapted mark is shared under the same licence, not ace's."),
        Entry(name: "parse5", licence: "MIT", notice: Self.bundledNotice("parse5-license")),
        Entry(name: "entities", licence: "BSD 2-Clause", notice: Self.bundledNotice("entities-license")),
        Entry(name: "markit", licence: "Apache License 2.0", notice: MarkitNoticesView.summary),
    ]
    private static func bundledNotice(_ name: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: "txt"), let text = try? String(contentsOf: url, encoding: .utf8) else { return "See \(name).txt in the app bundle." }
        return text
    }
    var body: some View {
        List {
            ForEach(entries) { entry in
                Section {
                    VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                        Text(entry.name).font(AceDesign.Typeface.body)
                        Text(entry.licence).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                        Text(entry.notice).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                    .padding(.vertical, AceDesign.Space.related)
                    .accessibilityElement(children: .combine)
                }
                .insetRowBackground()
            }
            Section {
                NavigationLink("markit's third-party licences") { MarkitNoticesView() }
                    .accessibilityIdentifier("licences.markit")
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle("Licences").navigationBarTitleDisplayMode(.inline)
    }
}
