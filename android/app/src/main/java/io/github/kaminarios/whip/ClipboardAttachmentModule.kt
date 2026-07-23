package io.github.kaminarios.whip

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class ClipboardAttachmentModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "ClipboardAttachment"

  @ReactMethod
  fun hasAttachment(promise: Promise) {
    promise.resolve(runCatching { clipboardUri(primaryClip()) != null }.getOrDefault(false))
  }

  @ReactMethod
  fun copyAttachment(promise: Promise) {
    try {
      val clip = primaryClip()
      val uri = clipboardUri(clip)
      if (uri == null) {
        promise.resolve(null)
        return
      }
      val resolver = reactContext.contentResolver
      val name = displayName(uri) ?: "clipboard-${System.currentTimeMillis()}"
      val directory = File(reactContext.cacheDir, "clipboard-attachments").apply { mkdirs() }
      val destination = File(directory, "${System.currentTimeMillis()}-${safeName(name)}")
      resolver.openInputStream(uri).use { input ->
        requireNotNull(input) { "The clipboard attachment could not be opened" }
        destination.outputStream().use { output -> input.copyTo(output) }
      }
      val result = Arguments.createMap().apply {
        putString("uri", Uri.fromFile(destination).toString())
        putString("name", name)
        putString("mimeType", resolver.getType(uri) ?: clip?.description?.getMimeType(0))
      }
      promise.resolve(result)
    } catch (error: Throwable) {
      promise.reject("E_CLIPBOARD_ATTACHMENT", "Could not read the clipboard attachment", error)
    }
  }

  private fun primaryClip(): ClipData? =
    (reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip

  private fun clipboardUri(clip: ClipData?): Uri? {
    if (clip == null || clip.itemCount == 0) return null
    for (index in 0 until clip.itemCount) {
      val item = clip.getItemAt(index)
      val uri = item.uri ?: item.intent?.data
      if (uri != null) return uri
    }
    return null
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

  private fun safeName(name: String): String =
    name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[^A-Za-z0-9._-]+"), "-")
}
