#if os(iOS)
import Foundation
import TallylineCore

extension BuildChannel {
    /// How this running build reached the phone. SettingsView takes it as a
    /// parameter so tests and previews can inject each channel.
    static var current: BuildChannel {
        #if DEBUG
        .debug
        #else
        .detect(receiptURL: Bundle.main.appStoreReceiptURL, isDebug: false)
        #endif
    }
}
#endif
