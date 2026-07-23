package io.github.kaminarios.whip

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class HerdrSystemSettingsModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "HerdrSystemSettings"

  @ReactMethod
  fun openNotificationSettings(promise: Promise) {
    try {
      val notificationSettingsIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
          putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        }
      } else {
        Intent(ACTION_APP_NOTIFICATION_SETTINGS).apply {
          putExtra(EXTRA_APP_PACKAGE, context.packageName)
          putExtra(EXTRA_APP_UID, context.applicationInfo.uid)
        }
      }

      val intent = if (notificationSettingsIntent.resolveActivity(context.packageManager) != null) {
        notificationSettingsIntent
      } else {
        Intent(
          Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          Uri.parse("package:${context.packageName}"),
        )
      }

      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("E_NOTIFICATION_SETTINGS", error)
    }
  }

  private companion object {
    const val ACTION_APP_NOTIFICATION_SETTINGS = "android.settings.APP_NOTIFICATION_SETTINGS"
    const val EXTRA_APP_PACKAGE = "app_package"
    const val EXTRA_APP_UID = "app_uid"
  }
}
