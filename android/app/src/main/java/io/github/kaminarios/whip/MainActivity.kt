package io.github.kaminarios.whip

import android.os.Bundle
import android.view.KeyEvent
import com.facebook.react.ReactApplication
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme)
    super.onCreate(null)
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (!HerdrVolumeKeysModule.shouldIntercept(keyCode)) return super.onKeyDown(keyCode, event)
    val value = HerdrVolumeKeysModule.eventValue(keyCode) ?: return super.onKeyDown(keyCode, event)
    val reactContext = (application as ReactApplication).reactHost?.currentReactContext
      ?: return super.onKeyDown(keyCode, event)
    reactContext.emitDeviceEvent(HerdrVolumeKeysModule.EVENT_NAME, value)
    return true
  }

  override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
    if (HerdrVolumeKeysModule.shouldIntercept(keyCode)) return true
    return super.onKeyUp(keyCode, event)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled),
      )
}
