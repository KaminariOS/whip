package com.herdr

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.content.edit

class HerdrBackgroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    acquireWakeLock()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE)
    val hostCount = intent
      ?.getIntExtra(EXTRA_HOST_COUNT, 0)
      ?.takeIf { it > 0 }
      ?: preferences.getInt(EXTRA_HOST_COUNT, 1)
    preferences.edit { putInt(EXTRA_HOST_COUNT, hostCount) }
    promoteToForeground(hostCount)
    // The React Native runtime owns the SSH monitor. Do not restart only the
    // notification after Android has killed the whole application process.
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Herdr background monitoring",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Shows when Herdr is keeping remote sessions connected"
      setShowBadge(false)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun promoteToForeground(hostCount: Int) {
    val notification = buildNotification(hostCount)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(hostCount: Int): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(this, MainActivity::class.java)
    val contentIntent = PendingIntent.getActivity(
      this,
      0,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val noun = if (hostCount == 1) "host" else "hosts"
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
    }
    return builder
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("Herdr is monitoring in the background")
      .setContentText("Watching $hostCount remote $noun over SSH")
      .setContentIntent(contentIntent)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .build()
  }

  @SuppressLint("WakelockTimeout")
  private fun acquireWakeLock() {
    val powerManager = getSystemService(PowerManager::class.java)
    wakeLock = powerManager.newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK,
      "$packageName:herdr-monitoring",
    ).apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  companion object {
    const val ACTION_START = "com.herdr.action.START_BACKGROUND_MONITORING"
    const val EXTRA_HOST_COUNT = "host_count"
    private const val CHANNEL_ID = "herdr-background-monitoring"
    private const val NOTIFICATION_ID = 1937
    private const val PREFERENCES = "herdr-background-monitoring"
  }
}
