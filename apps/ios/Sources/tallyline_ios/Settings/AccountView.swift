#if os(iOS)
import SwiftUI
import UIKit
import TallylineCore
import TallylineDesign

struct AccountView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var renewing = false
    @State private var renewMessage: String?
    @State private var renewed = 0

    var body: some View {
        Form {
            Section {
                LabeledContent("Name", value: session.me?.name ?? "Unknown")
                LabeledContent("Workspace", value: credential.workspaceName)
                LabeledContent("Server", value: credential.serverURL.host ?? credential.serverURL.absoluteString)
            }
            Section {
                LabeledContent("Expires") {
                    Text(credential.expiresAt, format: .relative(presentation: .named))
                }
                Button(renewing ? "Renewing" : "Renew now") {
                    Task {
                        renewing = true
                        let ok = await session.rotateNow()
                        renewing = false
                        renewMessage = ok ? "Renewed." : "Could not renew. Check your connection."
                        if ok { renewed += 1 }
                    }
                }
                .disabled(renewing)
            } header: {
                Text("This phone's access")
            } footer: {
                Text(renewMessage ?? "Access renews itself before it expires. Renew now if you want a fresh one.")
            }
            Section {
                LabeledContent("This device", value: UIDevice.current.name)
            } header: {
                Text("Paired devices")
            } footer: {
                Text("Manage every paired device from Settings > Devices on the web.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: renewed)
    }
}
#endif
