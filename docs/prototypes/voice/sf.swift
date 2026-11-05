import Foundation
import Speech
let locs=["en-US","en-GB","fa-IR","it-IT"]
for l in locs { let r=SFSpeechRecognizer(locale: Locale(identifier:l)); print(l,"available:",r?.isAvailable ?? false,"onDevice:",r?.supportsOnDeviceRecognition ?? false) }
print("authStatus raw:",SFSpeechRecognizer.authorizationStatus().rawValue)
if #available(macOS 26.0, *) {
  let sem=DispatchSemaphore(value:0)
  Task { 
    print("SpeechTranscriber.isAvailable:",SpeechTranscriber.isAvailable)
    let sup=await SpeechTranscriber.supportedLocales
    print("supportedLocales:",sup.count, sup.prefix(8).map{$0.identifier})
    let inst=await SpeechTranscriber.installedLocales
    print("installedLocales:",inst.map{$0.identifier})
    sem.signal() }
  sem.wait()
}
