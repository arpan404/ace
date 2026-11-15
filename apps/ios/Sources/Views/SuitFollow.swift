import SwiftUI

/// Keeps the wanted Suit read from a connected machine that lists it (ADR 0150): read again when
/// its version changes, refused with the machine's reason when it fails its checks or is gone,
/// and its bundled fonts fetched before it shows. A machine that hasn't listed yet changes
/// nothing, so the Suit last shown holds through a reconnect.
struct SuitFollow: ViewModifier {
    let inbox: MachineInbox
    @Environment(SuitLookModel.self) private var suits: SuitLookModel?

    func body(content: Content) -> some View {
        content.task(id: key) { await follow() }
    }

    /// The wanted Suit and every ready machine's version of it: a change reads again.
    private var key: String {
        let wanted = suits?.wanted ?? ""
        var parts = [wanted]
        for session in ready {
            let rows: [PhoneSuitRow] = session.client.suits ?? []
            let hash: String = rows.first(where: { (row: PhoneSuitRow) -> Bool in row.id == wanted })?.contentHash ?? "-"
            parts.append(session.hostId + "=" + hash)
        }
        return parts.joined(separator: "|")
    }

    private var ready: [MachineSession] {
        inbox.sessions.filter { $0.client.connection == "ready" && $0.client.suits != nil }
    }

    private func follow() async {
        guard let suits, let wanted = suits.wanted else { return }
        let listing = ready.compactMap { session in session.client.suits?.first { $0.id == wanted }.map { (session.client, $0) } }
        guard let (client, row) = listing.first(where: { $0.1.unavailable == nil }) ?? listing.first else {
            // Every connected machine has listed and none has it.
            if !ready.isEmpty { suits.refuse(wanted, reason: "No connected machine has this Suit.") }
            return
        }
        if let reason = row.unavailable { suits.refuse(wanted, reason: reason); return }
        if let shown = suits.applied, shown.id == wanted, shown.contentHash == row.contentHash { return }
        do {
            let suit = try await client.service(["type": "suit.read", "id": wanted], as: PhoneSuit.self)
            guard !Task.isCancelled else { return }
            if suit.unavailable == nil {
                await fetchFonts(suit, from: client)
                await fetchStills(suit, from: client)
            }
            guard !Task.isCancelled else { return }
            suits.show(suit)
            SuitAssets.prune(keeping: suit)
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { suits.refuse(wanted, reason: error.localizedDescription) }
        }
    }

    /// Each bundled font file, read once per version; one that can't be read leaves the system font.
    private func fetchFonts(_ suit: PhoneSuit, from client: ClientModel) async {
        let paths = Set([suit.fonts.ui, suit.fonts.prose, suit.fonts.mono].compactMap { $0?.asset })
        for path in paths {
            _ = try? await SuitAssets.fetched(suit, path) {
                try await client.service(["type": "suit.asset", "id": suit.id, "contentHash": suit.contentHash, "path": path], as: AssetReply.self).data
            }
        }
    }

    /// Each scheme's still, read once per version, with the page tint at which words read over
    /// it. One that can't be read or solved leaves that scheme without a backdrop.
    private func fetchStills(_ suit: PhoneSuit, from client: ClientModel) async {
        for (scheme, path) in [("light", suit.stills.light), ("dark", suit.stills.dark)] {
            guard let path, let colours = suit.colours[scheme] else { continue }
            let asked: [String: Any] = ["type": "suit.asset", "id": suit.id, "contentHash": suit.contentHash, "path": path]
            guard let file = try? await SuitAssets.fetched(suit, path, fetch: { try await client.service(asked, as: AssetReply.self).data }),
                  let image = UIImage(contentsOfFile: file.path) else { continue }
            let cells = SuitStill.cells(image)
            guard !cells.isEmpty else { continue }
            let solve: [String: Any] = ["type": "suit.stillTint", "colours": colours, "cells": cells]
            guard let tint = try? await client.service(solve, as: TintReply.self).tint else { continue }
            SuitStill.keep(tint: tint, suit: suit, scheme: scheme)
        }
    }

    struct AssetReply: Decodable { let mimeType: String; let data: String }
    struct TintReply: Decodable { let tint: Double }
}

/// Puts the Suit on screen into the palette, the font faces and the shape tokens, or the theme
/// back with nil.
@MainActor enum SuitWear {
    static func apply(_ suit: PhoneSuit?, to palette: NativePaletteModel) {
        palette.wear(suit: suit?.pairs)
        SuitShape.shared.wear(radius: CGFloat(suit?.radius ?? 1), border: CGFloat(suit?.border ?? 1))
        let face = { (slot: PhoneSuit.Face?) -> String? in
            guard let suit, let slot else { return nil }
            let file = slot.asset.flatMap { SuitAssets.file(suit, $0) }.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
            // A bundled file that never arrived leaves the system font, never a missing face.
            if slot.asset != nil && file == nil { return nil }
            return SuitFonts.face(slot, file: file)
        }
        SuitFaces.shared.wear(ui: face(suit?.fonts.ui), prose: face(suit?.fonts.prose), mono: face(suit?.fonts.mono))
        SuitStill.shared.wear(suit)
    }
}
