package io.github.kaminarios.whip

import android.view.KeyEvent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class HerdrVolumeKeysModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "HerdrVolumeKeys"

  @ReactMethod
  fun configure(enabled: Boolean, interceptVolumeUp: Boolean, interceptVolumeDown: Boolean) {
    isEnabled = enabled
    interceptUp = interceptVolumeUp
    interceptDown = interceptVolumeDown
  }

  companion object {
    const val EVENT_NAME = "herdrVolumeKey"

    @Volatile private var isEnabled = false
    @Volatile private var interceptUp = false
    @Volatile private var interceptDown = false

    fun shouldIntercept(keyCode: Int): Boolean = isEnabled && when (keyCode) {
      KeyEvent.KEYCODE_VOLUME_UP -> interceptUp
      KeyEvent.KEYCODE_VOLUME_DOWN -> interceptDown
      else -> false
    }

    fun eventValue(keyCode: Int): String? = when (keyCode) {
      KeyEvent.KEYCODE_VOLUME_UP -> "up"
      KeyEvent.KEYCODE_VOLUME_DOWN -> "down"
      else -> null
    }
  }
}
