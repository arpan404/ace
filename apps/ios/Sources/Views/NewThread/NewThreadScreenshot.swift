import Photos
import UIKit

/// The newest screenshot in Photos, offered as a suggestion when the person has already given
/// ace access to their photos (all, or the ones they chose). It never asks for access: without
/// it, + opens the system photo picker, which needs none.
struct LatestScreenshot: Equatable, Sendable {
    let assetId: String
    let taken: Date

    /// How old a screenshot can be and still be the one the person most likely means.
    static let fresh: TimeInterval = 30 * 60

    /// The newest screenshot taken in the last half hour, read only with access already granted.
    static func read(now: Date) -> LatestScreenshot? {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return nil }
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.predicate = NSPredicate(format: "(mediaSubtypes & %d) != 0 AND creationDate > %@",
                                        PHAssetMediaSubtype.photoScreenshot.rawValue, now.addingTimeInterval(-fresh) as NSDate)
        options.fetchLimit = 1
        guard let asset = PHAsset.fetchAssets(with: .image, options: options).firstObject, let taken = asset.creationDate else { return nil }
        return LatestScreenshot(assetId: asset.localIdentifier, taken: taken)
    }

    /// "Screenshot 9:38", in the phone's own time format.
    var label: String { "Screenshot " + taken.formatted(date: .omitted, time: .shortened) }

    /// A small square of it for the capsule.
    func thumbnail(side: CGFloat, scale: CGFloat) async -> UIImage? {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else { return nil }
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = false
        let size = CGSize(width: side * scale, height: side * scale)
        return await withCheckedContinuation { done in
            PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFill, options: options) { image, _ in
                done.resume(returning: image)
            }
        }
    }

    /// The screenshot's bytes as Photos keeps them (PNG), with its name and type.
    func data() async -> (data: Data, name: String, mimeType: String)? {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else { return nil }
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.version = .current
        return await withCheckedContinuation { done in
            PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, type, _, _ in
                guard let data else { done.resume(returning: nil); return }
                let png = type.map { $0.contains("png") } ?? true
                done.resume(returning: (data, png ? "Screenshot.png" : "Screenshot.jpg", png ? "image/png" : "image/jpeg"))
            }
        }
    }
}
