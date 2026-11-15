import VideoToolbox
import CoreMedia
func hex(_ p: UnsafePointer<UInt8>, _ n: Int) -> String { (0..<n).map { String(format: "%02x", p[$0]) }.joined() }
func run(_ codec: CMVideoCodecType, _ profile: CFString, _ w: Int32, _ h: Int32, _ name: String) {
  var session: VTCompressionSession?
  var st = VTCompressionSessionCreate(allocator: nil, width: w, height: h, codecType: codec, encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &session)
  guard st == 0, let s = session else { print("fail", st); return }
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel, value: profile)
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: 60 as CFNumber)
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
  var pb: CVPixelBuffer?
  CVPixelBufferCreate(nil, Int(w), Int(h), kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
  let sem = DispatchSemaphore(value: 0)
  st = VTCompressionSessionEncodeFrame(s, imageBuffer: pb!, presentationTimeStamp: CMTime(value: 0, timescale: 60), duration: .invalid, frameProperties: nil, infoFlagsOut: nil) { status, _, sb in
    defer { sem.signal() }
    guard let sb = sb, let fd = CMSampleBufferGetFormatDescription(sb) else { print("nooutput", status); return }
    var count = 0
    if codec == kCMVideoCodecType_H264 { CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) }
    else { CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(fd, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) }
    for i in 0..<count {
      var p: UnsafePointer<UInt8>?; var n = 0
      if codec == kCMVideoCodecType_H264 { CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, parameterSetIndex: i, parameterSetPointerOut: &p, parameterSetSizeOut: &n, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) }
      else { CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(fd, parameterSetIndex: i, parameterSetPointerOut: &p, parameterSetSizeOut: &n, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) }
      print(name, i, hex(p!, n))
    }
    if let bb = CMSampleBufferGetDataBuffer(sb) {
      var len = 0; var ptr: UnsafeMutablePointer<Int8>?
      CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr)
      let p = UnsafeRawPointer(ptr!).assumingMemoryBound(to: UInt8.self)
      var o = 0
      while o + 4 <= len { let n = Int(p[o])<<24|Int(p[o+1])<<16|Int(p[o+2])<<8|Int(p[o+3]); print(name, "frame", 0, "nal", hex(p+o+4, min(n, 320))); o += 4 + n }
    }
    if let ext = CMFormatDescriptionGetExtension(fd, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any] {
      for (k, v) in ext { if let d = v as? Data { print(name, k, d.map { String(format: "%02x", $0) }.joined()) } }
    }
  }
  sem.wait()
  for f in 1...2 {
    let sem2 = DispatchSemaphore(value: 0)
    VTCompressionSessionEncodeFrame(s, imageBuffer: pb!, presentationTimeStamp: CMTime(value: Int64(f), timescale: 60), duration: .invalid, frameProperties: nil, infoFlagsOut: nil) { _, _, sb in
      defer { sem2.signal() }
      guard let sb = sb, let bb = CMSampleBufferGetDataBuffer(sb) else { return }
      var len = 0; var ptr: UnsafeMutablePointer<Int8>?
      CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr)
      let p = UnsafeRawPointer(ptr!).assumingMemoryBound(to: UInt8.self)
      var o = 0
      while o + 4 <= len { let n = Int(p[o])<<24|Int(p[o+1])<<16|Int(p[o+2])<<8|Int(p[o+3]); print(name, "frame", f, "nal", hex(p+o+4, min(n, 320))); o += 4 + n }
    }
    sem2.wait()
  }
  VTCompressionSessionInvalidate(s)
}
run(kCMVideoCodecType_H264, kVTProfileLevel_H264_High_AutoLevel, 1920, 1080, "h264-high-1080")
run(kCMVideoCodecType_H264, kVTProfileLevel_H264_Main_AutoLevel, 1280, 720, "h264-main-720")
run(kCMVideoCodecType_H264, kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel, 1206, 2622, "h264-cb-1206")
run(kCMVideoCodecType_HEVC, kVTProfileLevel_HEVC_Main_AutoLevel, 1920, 1080, "hevc-main-1080")
run(kCMVideoCodecType_HEVC, kVTProfileLevel_HEVC_Main_AutoLevel, 1206, 2622, "hevc-main-1206")
