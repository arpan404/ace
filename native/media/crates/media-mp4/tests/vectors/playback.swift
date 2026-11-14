// SPDX-License-Identifier: Apache-2.0
// Manual native decode smoke: swift playback.swift /path/to/exported/files
import Foundation
import AVFoundation
import CoreVideo

let directory = CommandLine.arguments[1]
for codec in ["h264", "hevc"] {
    for (suffix, expected) in [("", 3), ("-cut", 2)] {
        let asset = AVURLAsset(url: URL(fileURLWithPath: directory + "/" + codec + suffix + ".mp4"))
        let reader = try AVAssetReader(asset: asset)
        let track = asset.tracks(withMediaType: .video)[0]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output)
        guard reader.startReading() else { fatalError("cannot start: \(String(describing: reader.error))") }
        var frames = 0
        while let sample = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetImageBuffer(sample) != nil else { fatalError("not decoded") }
            frames += 1
        }
        guard frames == expected else { fatalError("\(codec)\(suffix): \(frames) frames, expected \(expected): \(String(describing: reader.error))") }
        print("\(codec)\(suffix): decoded \(frames) frames")
    }
}
