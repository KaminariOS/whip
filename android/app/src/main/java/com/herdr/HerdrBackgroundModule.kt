package com.herdr

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class HerdrBackgroundModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "HerdrBackground"

  @ReactMethod
  fun start(hostCount: Double, promise: Promise) {
    try {
      val intent = Intent(context, HerdrBackgroundService::class.java).apply {
        action = HerdrBackgroundService.ACTION_START
        putExtra(HerdrBackgroundService.EXTRA_HOST_COUNT, hostCount.toInt().coerceAtLeast(1))
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("E_BACKGROUND_MONITORING_START", error)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      context.stopService(Intent(context, HerdrBackgroundService::class.java))
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("E_BACKGROUND_MONITORING_STOP", error)
    }
  }
}
