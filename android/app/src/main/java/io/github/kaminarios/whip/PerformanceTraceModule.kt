package io.github.kaminarios.whip

import android.os.Build
import android.os.Trace
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class PerformanceTraceModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun beginAsyncSection(name: String, cookie: Double): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !Trace.isEnabled()) return false
    Trace.beginAsyncSection(name.take(MAX_SECTION_NAME_LENGTH), cookie.toInt())
    return true
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun endAsyncSection(name: String, cookie: Double): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !Trace.isEnabled()) return false
    Trace.endAsyncSection(name.take(MAX_SECTION_NAME_LENGTH), cookie.toInt())
    return true
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun setCounter(name: String, value: Double): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !Trace.isEnabled()) return false
    Trace.setCounter(name.take(MAX_SECTION_NAME_LENGTH), value.toLong())
    return true
  }

  companion object {
    const val NAME = "WhipPerformanceTrace"
    private const val MAX_SECTION_NAME_LENGTH = 127
  }
}
