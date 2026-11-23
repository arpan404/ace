import SwiftUI

/// A bot linked to an agent package (ADR 0200 §3.9), as one sentence above its task: the package
/// and version it came from, and that its version was withdrawn. Update when the Marketplace has
/// a newer one and Roll back to the version before each open the Marketplace's review, which
/// says what changes, what stays and what it asks for, and moves nothing until the person
/// installs from it. A bot from one of ace's templates updates from its Spade, through the same
/// kind of review (`SpadeTemplateUpdate`).
struct SpadeProfilePackage: View {
    let scope: SpadeProfileScope
    let line: SpadePackageLine
    /// The bot's package changed: its line and effects are read again.
    let changed: () async -> Void
    @State private var reviewing: MarketReviewSheet.Mode?
    @State private var template: TemplateVersion?

    /// The template version a review is open for.
    struct TemplateVersion: Identifiable {
        let id: String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            Text(line.sentence)
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(line.withdrawn ? AceTheme.StatusText.needsYou : AceDesign.Ink.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("spade.package.line")
            if line.update != nil || line.rollBack != nil || line.template != nil {
                HStack(spacing: AceDesign.Space.related) {
                    if let version = line.update {
                        Button("Update to \(version)", ace: .arrowCircleUp) { reviewing = .update(key) }
                            .accessibilityIdentifier("spade.package.update")
                    }
                    if let version = line.template {
                        Button("Update to \(version)", ace: .arrowCircleUp) { template = TemplateVersion(id: version) }
                            .accessibilityIdentifier("spade.package.template")
                    }
                    if let version = line.rollBack {
                        Button("Roll back to \(version)", ace: .arrowUUpLeft) { reviewing = .rollback(key) }
                            .accessibilityIdentifier("spade.package.rollback")
                    }
                }
                .buttonStyle(.secondaryAction)
                .controlSize(.small)
            }
        }
        .padding(.vertical, AceDesign.Space.tight)
        .sheet(item: $reviewing) { mode in
            MarketReviewSheet(model: scope.client, mode: mode, machineName: scope.machine) { landed in
                if landed != nil { Task { await changed() } }
            }
        }
        .sheet(item: $template) { version in
            NavigationStack {
                SpadeTemplateUpdate(scope: scope, version: version.id) { await changed() }
            }
        }
    }

    /// The bot's install in the Marketplace: a bot package's copy, by its bot.
    private var key: MarketInstalledKey {
        MarketInstalledKey(type: "spade-bot", name: line.name, bot: scope.agent)
    }
}

extension MarketReviewSheet.Mode: Identifiable {
    var id: Self { self }
}
