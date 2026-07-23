package io.github.kaminarios.whip

import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class HerdrSoftInputModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  private val overlayOwners = mutableSetOf<String>()

  override fun getName(): String = "HerdrSoftInput"

  @ReactMethod
  fun setComposerOverlayEnabled(owner: String, enabled: Boolean, promise: Promise) {
    val activity = context.currentActivity
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "No foreground activity is available")
      return
    }

    activity.runOnUiThread {
      try {
        if (enabled) {
          overlayOwners.add(owner)
        } else {
          overlayOwners.remove(owner)
        }
        val currentMode = activity.window.attributes.softInputMode
        val adjustment = if (overlayOwners.isNotEmpty()) {
          WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
        } else {
          WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        }
        val updatedMode =
          (currentMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST.inv()) or adjustment
        activity.window.setSoftInputMode(updatedMode)
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject("E_SOFT_INPUT_MODE", error)
      }
    }
  }
}
