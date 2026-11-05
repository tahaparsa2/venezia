// Venezia speech-to-text helper, built on first use by transcribe.mjs.
//
// In:  16 kHz mono Int16 little-endian PCM on stdin. End of input ends the session.
// Out: one JSON object per line on stdout:
//   {"type":"ready","locale":"en_US","sampleRate":16000}
//   {"type":"partial","text":"..."}    the sentence in progress, replaced by the next one
//   {"type":"final","text":"..."}      a settled sentence
//   {"type":"done","text":"..."}       every final joined, then a clean exit
//   {"type":"error","code":"...","message":"..."}
//
// With --probe it reports {"type":"probe",...} and exits without reading stdin.
//
// Clean shutdown matters here. The research harness called start(inputSequence:) and then
// finalizeAndFinishThroughEndOfInput(), which threw nilError after the results had already
// arrived. This uses analyzeSequence, which hands back the time of the last sample, and
// finishes through exactly that time.
//
// Two things found by measuring. An analyzer given an empty stream never returns, so a
// session with no audio ends before reaching it. And with no lead-in, the first word goes
// missing from the final text ("Tell Aurora to" settled as "Aurora to"), which is exactly
// where a command's verb sits, so every session starts with a moment of silence.

import AVFoundation
import Foundation
import Speech

let outputLock = NSLock()

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  outputLock.lock()
  defer { outputLock.unlock() }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

func fail(_ code: String, _ message: String) -> Int32 {
  emit(["type": "error", "code": code, "message": message])
  return 1
}

struct Options {
  var locale = "en-US"
  var hints: [String] = []
  var probe = false
}

func parseOptions() -> Options {
  var options = Options()
  var arguments = CommandLine.arguments.dropFirst().makeIterator()
  while let argument = arguments.next() {
    switch argument {
    case "--probe": options.probe = true
    case "--locale": options.locale = arguments.next() ?? options.locale
    case "--hint": if let hint = arguments.next() { options.hints.append(hint) }
    default: break
    }
  }
  return options
}

let sourceSampleRate = 16000.0
let chunkBytes = 3200  // 100 ms of 16 kHz Int16
let leadInBytes = 9600  // 300 ms

/// Reads stdin on its own thread and turns it into audio buffers of the analyzer's format.
@available(macOS 26.0, *)
final class AudioPump: @unchecked Sendable {
  let source: AVAudioFormat
  let target: AVAudioFormat
  let converter: AVAudioConverter?
  let continuation: AsyncStream<AnalyzerInput>.Continuation

  init?(target: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation) {
    guard
      let source = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: sourceSampleRate, channels: 1, interleaved: true)
    else { return nil }
    self.source = source
    self.target = target
    self.continuation = continuation
    if source.isEqual(target) {
      converter = nil
    } else {
      guard let made = AVAudioConverter(from: source, to: target) else { return nil }
      converter = made
    }
  }

  func start() {
    let thread = Thread { [self] in
      var pending = Data()
      var buffer = [UInt8](repeating: 0, count: 65536)
      var heardAudio = false
      while true {
        let count = read(STDIN_FILENO, &buffer, buffer.count)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { break }
        if !heardAudio {
          heardAudio = true
          push(Data(count: leadInBytes))
        }
        pending.append(contentsOf: buffer[0..<count])
        // Whole chunks only, so a frame split across reads keeps its second byte.
        while pending.count >= chunkBytes {
          push(pending.prefix(chunkBytes))
          pending.removeFirst(chunkBytes)
        }
      }
      if !heardAudio {
        emit(["type": "done", "text": ""])
        exit(0)
      }
      let whole = pending.count - pending.count % 2
      if whole > 0 { push(pending.prefix(whole)) }
      continuation.finish()
    }
    thread.start()
  }

  private func push(_ bytes: Data) {
    let frames = AVAudioFrameCount(bytes.count / 2)
    guard let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: frames),
      let samples = input.int16ChannelData?[0]
    else { return }
    input.frameLength = frames
    bytes.withUnsafeBytes { raw in
      if let base = raw.baseAddress { memcpy(samples, base, bytes.count) }
    }
    guard let converter else {
      continuation.yield(AnalyzerInput(buffer: input))
      return
    }
    let ratio = target.sampleRate / source.sampleRate
    let capacity = AVAudioFrameCount(Double(frames) * ratio) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var given = false
    var problem: NSError?
    converter.convert(to: output, error: &problem) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return input
    }
    if problem == nil && output.frameLength > 0 {
      continuation.yield(AnalyzerInput(buffer: output))
    }
  }
}

@available(macOS 26.0, *)
func installedLocale(for identifier: String) async -> Locale? {
  let wanted = Locale(identifier: identifier)
  guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else { return nil }
  let installed = await SpeechTranscriber.installedLocales
  return installed.first { $0.identifier(.bcp47) == supported.identifier(.bcp47) }
}

@available(macOS 26.0, *)
func probe(_ options: Options) async -> Int32 {
  let locale = await installedLocale(for: options.locale)
  emit([
    "type": "probe",
    "available": SpeechTranscriber.isAvailable && locale != nil,
    "transcriber": SpeechTranscriber.isAvailable,
    "locale": locale?.identifier ?? NSNull(),
  ])
  return 0
}

@available(macOS 26.0, *)
func transcribe(_ options: Options) async -> Int32 {
  guard SpeechTranscriber.isAvailable else {
    return fail("speech_unavailable", "Apple speech recognition is not available on this Mac")
  }
  guard let locale = await installedLocale(for: options.locale) else {
    return fail("locale_unavailable", "The speech model for \(options.locale) is not installed")
  }

  let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
  let analyzer = SpeechAnalyzer(modules: [transcriber])

  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
    return fail("no_audio_format", "No audio format works with the speech model")
  }
  if !options.hints.isEmpty {
    let context = AnalysisContext()
    context.contextualStrings[.general] = options.hints
    try? await analyzer.setContext(context)
  }

  let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
  guard let pump = AudioPump(target: format, continuation: continuation) else {
    return fail("no_audio_format", "Could not convert 16 kHz audio for the speech model")
  }

  let collector = Task { () -> [String] in
    var finals: [String] = []
    for try await result in transcriber.results {
      let text = String(result.text.characters)
      if result.isFinal {
        finals.append(text)
        emit(["type": "final", "text": text])
      } else {
        emit(["type": "partial", "text": text])
      }
    }
    return finals
  }

  emit(["type": "ready", "locale": locale.identifier, "sampleRate": Int(format.sampleRate)])
  pump.start()

  do {
    if let last = try await analyzer.analyzeSequence(stream) {
      try await analyzer.finalizeAndFinish(through: last)
    }
    let finals = try await collector.value
    let text = finals.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
    emit(["type": "done", "text": text])
    return 0
  } catch {
    collector.cancel()
    return fail("analysis_failed", String(describing: error))
  }
}

signal(SIGPIPE, SIG_IGN)
let options = parseOptions()
guard #available(macOS 26.0, *) else {
  exit(fail("unsupported_os", "Speech recognition here needs macOS 26 or later"))
}
let finished = DispatchSemaphore(value: 0)
nonisolated(unsafe) var status: Int32 = 0
Task {
  status = options.probe ? await probe(options) : await transcribe(options)
  finished.signal()
}
finished.wait()
exit(status)
