package io.github.kaminarios.whip

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class ImageLibraryPickerModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), ActivityEventListener {
  private var pendingPromise: Promise? = null

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = "ImageLibraryPicker"

  @ReactMethod
  fun pickImage(promise: Promise) {
    if (pendingPromise != null) {
      promise.reject("E_IMAGE_PICKER_BUSY", "An image picker is already open")
      return
    }

    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("E_IMAGE_PICKER_UNAVAILABLE", "The image picker is unavailable")
      return
    }

    pendingPromise = promise
    try {
      activity.startActivityForResult(imagePickerIntent(), REQUEST_IMAGE)
    } catch (error: Throwable) {
      pendingPromise = null
      promise.reject("E_IMAGE_PICKER_OPEN", "Could not open the image picker", error)
    }
  }

  override fun onActivityResult(
    activity: Activity,
    requestCode: Int,
    resultCode: Int,
    data: Intent?,
  ) {
    if (requestCode != REQUEST_IMAGE) return
    val promise = pendingPromise ?: return
    pendingPromise = null

    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) {
      promise.resolve(null)
      return
    }

    try {
      promise.resolve(copyPickedImage(uri))
    } catch (error: Throwable) {
      promise.reject("E_IMAGE_PICKER_READ", "Could not use the selected image", error)
    }
  }

  override fun onNewIntent(intent: Intent) = Unit

  private fun imagePickerIntent(): Intent =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      Intent(MediaStore.ACTION_PICK_IMAGES).apply {
        type = "image/*"
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
    } else {
      Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "image/*"
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
    }

  private fun copyPickedImage(uri: Uri) = Arguments.createMap().apply {
    val resolver = reactContext.contentResolver
    val mimeType = resolver.getType(uri)
    val originalName = displayName(uri) ?: defaultName(mimeType)
    val directory = File(reactContext.cacheDir, "image-library-picker").apply { mkdirs() }
    val destination = File(directory, "${System.currentTimeMillis()}-${safeName(originalName)}")

    resolver.openInputStream(uri).use { input ->
      requireNotNull(input) { "The selected image could not be opened" }
      destination.outputStream().use { output -> input.copyTo(output) }
    }

    putString("uri", Uri.fromFile(destination).toString())
    putString("name", originalName)
    putString("mimeType", mimeType)
  }

  private fun displayName(uri: Uri): String? {
    reactContext.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null).use { cursor ->
      if (cursor != null && cursor.moveToFirst()) {
        val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (index >= 0) return cursor.getString(index)
      }
    }
    return uri.lastPathSegment
  }

  private fun defaultName(mimeType: String?): String = when (mimeType) {
    "image/png" -> "image.png"
    "image/webp" -> "image.webp"
    "image/gif" -> "image.gif"
    "image/heic", "image/heif" -> "image.heic"
    else -> "image.jpg"
  }

  private fun safeName(name: String): String {
    val safe = name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[^A-Za-z0-9._-]+"), "-")
    return safe.ifBlank { "image.jpg" }
  }

  companion object {
    private const val REQUEST_IMAGE = 7713
  }
}
