import CoreVideo
import Foundation
import Testing
@testable import Ace

private final class VideoFixtureBundle: NSObject {}

@Suite struct VideoDecodeTests {
    private struct Recording: Decodable {
        let codec: String
        let description: String
        let chunks: [String]
    }
    @Test func recordedBrowserKeyframesAndDeltasDecodeAtTheirCodedSize() throws {
        let url = try #require(Bundle(for: VideoFixtureBundle.self).url(forResource: "video-chunks", withExtension: "json"))
        let recordings = try JSONDecoder().decode([Recording].self, from: Data(contentsOf: url))
        #expect(recordings.count == 2)
        for recording in recordings {
            let description = try #require(Data(base64Encoded: recording.description))
            let decoder = try VideoDecoder(config: VideoDecoderConfig(codec: recording.codec, codedWidth: 320, codedHeight: 240, description: description))
            let sets: [Data]
            let lengthSize: Int
            if VideoCapabilities.isHEVC(recording.codec) {
                let config = try HEVCDescription(description)
                sets = config.parameterSets; lengthSize = config.nalLengthSize
            } else {
                let config = try AVCDescription(description)
                sets = config.sequenceParameterSets + config.pictureParameterSets; lengthSize = config.nalLengthSize
            }
            let key = try #require(recording.chunks.first.flatMap { Data(base64Encoded: $0) })
            let annexDecoder = try VideoDecoder(annexBKeyframe: DeviceH264Tests.annexB(prefix: sets, lengthPrefixed: key, lengthSize: lengthSize), codec: recording.codec)
            #expect(recording.chunks.count == 2)
            for chunk in recording.chunks {
                let bytes = try #require(Data(base64Encoded: chunk))
                let picture = try decoder.decode(bytes)
                #expect(CVPixelBufferGetWidth(picture) == 320)
                #expect(CVPixelBufferGetHeight(picture) == 240)
                let annexPicture = try annexDecoder.decode(annexB: DeviceH264Tests.annexB(prefix: [], lengthPrefixed: bytes, lengthSize: lengthSize))
                #expect(CVPixelBufferGetWidth(annexPicture) == 320)
                #expect(CVPixelBufferGetHeight(annexPicture) == 240)
            }
        }
    }
}
