package io.github.kaminarios.whip

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class HerdrBackgroundPackage : ReactPackage {
  @Suppress("OVERRIDE_DEPRECATION")
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(
      ClipboardAttachmentModule(reactContext),
      CredentialVaultModule(reactContext),
      HerdrBackgroundModule(reactContext),
      HerdrSystemSettingsModule(reactContext),
      PrivateKeyFilePickerModule(reactContext),
    )

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
