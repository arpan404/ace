import Markit
import SwiftUI
import UIKit

/// Pull request, issue and comment text, drawn by markit in GitHub's flavour (ADR 0096): alerts,
/// footnotes, task boxes, tables, raw HTML from GitHub's allowlist, emoji shortcodes, `@mentions`,
/// `#123` and commit references, images through the daemon and mermaid diagrams drawn offline.
/// A task box ticks only where `tick` is given (the viewer may edit the text); its offset is the
/// UTF-16 index of the mark inside `[ ]` in `text`, which must be the text the bridge remembers
/// as shown.
struct ForgeText: View {
    let text: String
    let scope: ForgeRichScope
    /// Ticks the box whose mark sits at an offset; nil leaves boxes showing their state only.
    var tick: ((Int, Bool) -> Void)? = nil
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let links = ForgeLinks(scope.repository)
        let dark = scheme == .dark
        AceMarkdown(text: text, resolveImage: images(links), flavor: .github,
                    onTask: ticker,
                    renderDiagram: { language, source in
                        guard language.lowercased() == "mermaid" else { return nil }
                        return await MermaidDiagram.render(source, dark: dark)
                    },
                    route: MarkdownRoute(link: { links?.link($0) ?? ForgeLinks.web($0) },
                                         reference: { links?.reference(kind: $0.kind, target: $0.target) }))
            // markit asks for a diagram once per source; a new appearance draws the text, and its
            // diagrams in the new scheme, again.
            .id(scheme)
    }

    /// A tapped box asks for its state at its mark's offset.
    private var ticker: ((MarkitTask) -> Void)? {
        guard let tick else { return nil }
        return { task in tick(task.offset, task.checked) }
    }

    /// Images load only through the daemon (`forge.media`), never from the phone.
    private func images(_ links: ForgeLinks?) -> @MainActor (String) async -> UIImage? {
        let scope = scope
        return { source in
            guard let address = links?.image(source) ?? ForgeLinks.webImage(source),
                  let media = await ForgeMediaCache.shared.load(address, role: "image", scope: scope),
                  media.state == "ready", let data = media.data.flatMap({ Data(base64Encoded: $0) }) else { return nil }
            return UIImage(data: data)
        }
    }
}
