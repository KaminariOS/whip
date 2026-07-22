package io.github.kaminarios.whip

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets

class PrivateKeyFilePickerModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), ActivityEventListener {
  private var pendingPromise: Promise? = null

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = "PrivateKeyFilePicker"

  @ReactMethod
  fun pickPrivateKey(promise: Promise) {
    if (pendingPromise != null) {
      promise.reject("E_KEY_PICKER_BUSY", "A private key file picker is already open")
      return
    }

    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("E_KEY_PICKER_UNAVAILABLE", "The private key file picker is unavailable")
      return
    }

    pendingPromise = promise
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
      }
      activity.startActivityForResult(intent, REQUEST_PRIVATE_KEY)
    } catch (error: Throwable) {
      pendingPromise = null
      promise.reject("E_KEY_PICKER_OPEN", "Could not open the private key file picker", error)
    }
  }

  override fun onActivityResult(
    activity: Activity,
    requestCode: Int,
    resultCode: Int,
    data: Intent?,
  ) {
    if (requestCode != REQUEST_PRIVATE_KEY) return
    val promise = pendingPromise ?: return
    pendingPromise = null

    if (resultCode != Activity.RESULT_OK || data?.data == null) {
      promise.resolve(null)
      return
    }

    try {
      val stream = reactContext.contentResolver.openInputStream(data.data!!)
        ?: error("The selected file could not be opened")
      val output = ByteArrayOutputStream()
      stream.use { input ->
        val buffer = ByteArray(8192)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          output.write(buffer, 0, count)
          if (output.size() > MAX_KEY_BYTES) error("The selected file is too large")
        }
      }
      promise.resolve(output.toString(StandardCharsets.UTF_8.name()))
    } catch (error: Throwable) {
      promise.reject("E_KEY_FILE_READ", "Could not read the selected private key", error)
    }
  }

  override fun onNewIntent(intent: Intent) = Unit

  companion object {
    private const val REQUEST_PRIVATE_KEY = 7712
    private const val MAX_KEY_BYTES = 1024 * 1024
  }
}
