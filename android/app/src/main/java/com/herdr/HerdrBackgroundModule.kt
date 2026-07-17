package com.herdr

import android.app.NotificationManager
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import kotlin.math.sqrt

class HerdrBackgroundModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context), SensorEventListener {
  private val sensorManager = context.getSystemService(SensorManager::class.java)
  private val notificationManager = context.getSystemService(NotificationManager::class.java)
  private val mainHandler = Handler(Looper.getMainLooper())
  private var activeAlertIdentifier: String? = null
  private var lastShakeAtMs = 0L
  private val disarmRunnable = Runnable { disarmShakeDetector() }

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

  @ReactMethod
  fun armShakeToStop(
    notificationIdentifier: String,
    timeoutMs: Double,
    promise: Promise,
  ) {
    mainHandler.post {
      try {
        val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
          ?: throw IllegalStateException("This device has no accelerometer")
        disarmShakeDetector()
        activeAlertIdentifier = notificationIdentifier
        lastShakeAtMs = 0L
        val registered = sensorManager.registerListener(
          this,
          accelerometer,
          SensorManager.SENSOR_DELAY_GAME,
          mainHandler,
        )
        if (!registered) throw IllegalStateException("Could not start accelerometer listener")
        mainHandler.postDelayed(
          disarmRunnable,
          timeoutMs.toLong().coerceIn(MIN_SHAKE_WINDOW_MS, MAX_SHAKE_WINDOW_MS),
        )
        promise.resolve(null)
      } catch (error: Throwable) {
        disarmShakeDetector()
        promise.reject("E_SHAKE_TO_STOP_ARM", error)
      }
    }
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
    val x = event.values[0] / SensorManager.GRAVITY_EARTH
    val y = event.values[1] / SensorManager.GRAVITY_EARTH
    val z = event.values[2] / SensorManager.GRAVITY_EARTH
    val gravityForce = sqrt(x * x + y * y + z * z)
    val now = SystemClock.elapsedRealtime()
    if (gravityForce < SHAKE_GRAVITY_THRESHOLD || now - lastShakeAtMs < SHAKE_SLOP_MS) return
    lastShakeAtMs = now

    val identifier = activeAlertIdentifier ?: return
    notificationManager.cancel(identifier, EXPO_NOTIFICATION_ID)
    cancelVibration()
    Log.i(TAG, "Shake detected; stopped agent alert $identifier")
    disarmShakeDetector()
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  override fun invalidate() {
    mainHandler.post { disarmShakeDetector() }
    super.invalidate()
  }

  private fun disarmShakeDetector() {
    mainHandler.removeCallbacks(disarmRunnable)
    sensorManager.unregisterListener(this)
    activeAlertIdentifier = null
  }

  @Suppress("DEPRECATION")
  private fun cancelVibration() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(VibratorManager::class.java).defaultVibrator.cancel()
    } else {
      (context.getSystemService(Vibrator::class.java)).cancel()
    }
  }

  companion object {
    private const val TAG = "HerdrShakeToStop"
    private const val EXPO_NOTIFICATION_ID = 0
    private const val SHAKE_GRAVITY_THRESHOLD = 2.7f
    private const val SHAKE_SLOP_MS = 750L
    private const val MIN_SHAKE_WINDOW_MS = 1_000L
    private const val MAX_SHAKE_WINDOW_MS = 60_000L
  }
}
