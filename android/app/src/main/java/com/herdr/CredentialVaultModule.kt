package com.herdr

import android.annotation.SuppressLint
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class CredentialVaultModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  private val preferences = context.getSharedPreferences(LOCAL_PREFERENCES, 0)
  private val blockstore by lazy { Blockstore.getClient(context) }
  private var activePrompt: BiometricPrompt? = null
  private var pendingUnlock: Promise? = null

  override fun getName(): String = "HerdrCredentialVault"

  @ReactMethod
  fun hasLocalRecoveryKey(promise: Promise) {
    promise.resolve(readLocalRecoveryKey() != null)
  }

  @ReactMethod
  fun encryptCredential(plaintext: String, credentialId: String, promise: Promise) {
    val existing = readLocalRecoveryKey()
    if (existing != null) {
      try {
        promise.resolve(encrypt(existing, plaintext, credentialId))
        refreshCloudRecovery(existing)
      } catch (error: Throwable) {
        promise.reject("E_CREDENTIAL_VAULT_ENCRYPT", error)
      }
      return
    }

    val recoveryKey = ByteArray(RECOVERY_KEY_BYTES).also(SecureRandom()::nextBytes)
    storeInitialRecoveryKey(
      recoveryKey,
      onSuccess = {
        try {
          installLocalRecoveryKey(recoveryKey)
          promise.resolve(encrypt(recoveryKey, plaintext, credentialId))
        } catch (error: Throwable) {
          promise.reject("E_CREDENTIAL_VAULT_ENCRYPT", error)
        }
      },
      onFailure = { promise.reject("E_CREDENTIAL_VAULT_BLOCK_STORE", it) },
    )
  }

  @ReactMethod
  fun decryptCredential(ciphertext: String, credentialId: String, promise: Promise) {
    val recoveryKey = readLocalRecoveryKey()
      ?: return promise.reject(
        "E_CREDENTIAL_VAULT_LOCKED",
        "Restored credentials must be unlocked first",
      )
    try {
      promise.resolve(decrypt(recoveryKey, ciphertext, credentialId))
    } catch (error: Throwable) {
      promise.reject("E_CREDENTIAL_VAULT_DECRYPT", error)
    }
  }

  @ReactMethod
  fun unlockRecoveryKey(promise: Promise) {
    if (readLocalRecoveryKey() != null) {
      promise.resolve(true)
      return
    }
    val activity = context.currentActivity as? FragmentActivity
      ?: return promise.reject(
        "E_CREDENTIAL_VAULT_ACTIVITY",
        "Credential recovery requires the active Herdr screen",
      )

    context.runOnUiQueueThread {
      if (pendingUnlock != null) {
        promise.reject("E_CREDENTIAL_VAULT_BUSY", "Credential recovery is already in progress")
        return@runOnUiQueueThread
      }
      pendingUnlock = promise
      val executor = ContextCompat.getMainExecutor(activity)
      activePrompt = BiometricPrompt(
        activity,
        executor,
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            retrieveRecoveryKey()
          }

          override fun onAuthenticationError(errorCode: Int, errorMessage: CharSequence) {
            finishUnlockError(
              if (errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                errorCode == BiometricPrompt.ERROR_CANCELED
              ) "E_CREDENTIAL_VAULT_CANCELLED" else "E_CREDENTIAL_VAULT_AUTH",
              errorMessage.toString(),
            )
          }
        },
      )
      try {
        activePrompt?.authenticate(buildPromptInfo())
      } catch (error: Throwable) {
        finishUnlockError("E_CREDENTIAL_VAULT_AUTH", error)
      }
    }
  }

  @ReactMethod
  fun clearRecoveryKey(promise: Promise) {
    val request = DeleteBytesRequest.Builder().setDeleteAll(true).build()
    blockstore.deleteBytes(request).addOnCompleteListener { task ->
      clearLocalRecoveryKey()
      if (task.isSuccessful) promise.resolve(null)
      else promise.reject("E_CREDENTIAL_VAULT_CLEAR", task.exception)
    }
  }

  override fun invalidate() {
    activePrompt?.cancelAuthentication()
    pendingUnlock?.reject("E_CREDENTIAL_VAULT_CANCELLED", "Credential recovery was interrupted")
    activePrompt = null
    pendingUnlock = null
    super.invalidate()
  }

  @Suppress("DEPRECATION")
  private fun buildPromptInfo(): BiometricPrompt.PromptInfo {
    val builder = BiometricPrompt.PromptInfo.Builder()
      .setTitle("Unlock restored SSH credentials")
      .setSubtitle("Use your fingerprint, face, or device screen lock")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
    } else {
      builder.setDeviceCredentialAllowed(true)
    }
    return builder.build()
  }

  private fun retrieveRecoveryKey() {
    val request = RetrieveBytesRequest.Builder()
      .setKeys(listOf(BLOCK_STORE_KEY))
      .build()
    blockstore.retrieveBytes(request)
      .addOnSuccessListener { response ->
        val bytes = response.blockstoreDataMap[BLOCK_STORE_KEY]?.bytes
        if (bytes == null || bytes.size != RECOVERY_KEY_BYTES) {
          finishUnlockError(
            "E_CREDENTIAL_VAULT_NOT_FOUND",
            "No recovery key was found in Android Block Store",
          )
          return@addOnSuccessListener
        }
        try {
          installLocalRecoveryKey(bytes)
          finishUnlockSuccess()
        } catch (error: Throwable) {
          finishUnlockError("E_CREDENTIAL_VAULT_INSTALL", error)
        }
      }
      .addOnFailureListener { finishUnlockError("E_CREDENTIAL_VAULT_RETRIEVE", it) }
  }

  private fun storeInitialRecoveryKey(
    recoveryKey: ByteArray,
    onSuccess: () -> Unit,
    onFailure: (Throwable) -> Unit,
  ) {
    blockstore.isEndToEndEncryptionAvailable().addOnCompleteListener { encryptionTask ->
      val cloudEnabled = encryptionTask.isSuccessful && encryptionTask.result == true
      val request = StoreBytesData.Builder()
        .setKey(BLOCK_STORE_KEY)
        .setBytes(recoveryKey)
        .setShouldBackupToCloud(cloudEnabled)
        .build()
      blockstore.storeBytes(request)
        .addOnSuccessListener { onSuccess() }
        .addOnFailureListener(onFailure)
    }
  }

  private fun refreshCloudRecovery(recoveryKey: ByteArray) {
    blockstore.isEndToEndEncryptionAvailable()
      .addOnSuccessListener { available ->
        if (!available) return@addOnSuccessListener
        val request = StoreBytesData.Builder()
          .setKey(BLOCK_STORE_KEY)
          .setBytes(recoveryKey)
          .setShouldBackupToCloud(true)
          .build()
        blockstore.storeBytes(request)
          .addOnFailureListener { Log.w(TAG, "Could not refresh Block Store recovery key", it) }
      }
      .addOnFailureListener { Log.w(TAG, "Could not check Block Store encryption", it) }
  }

  @SuppressLint("ApplySharedPref")
  @Synchronized
  private fun installLocalRecoveryKey(recoveryKey: ByteArray) {
    require(recoveryKey.size == RECOVERY_KEY_BYTES) { "Invalid recovery key size" }
    val cipher = Cipher.getInstance(AES_TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, getOrCreateWrappingKey())
    val encrypted = cipher.doFinal(recoveryKey)
    val payload = ByteArray(1 + cipher.iv.size + encrypted.size)
    payload[0] = cipher.iv.size.toByte()
    cipher.iv.copyInto(payload, 1)
    encrypted.copyInto(payload, 1 + cipher.iv.size)
    // Persist before returning encrypted credentials so the recovery key cannot lag behind them.
    preferences.edit(commit = true) {
      putString(WRAPPED_RECOVERY_KEY, encode(payload))
    }
  }

  @Synchronized
  private fun readLocalRecoveryKey(): ByteArray? {
    val encoded = preferences.getString(WRAPPED_RECOVERY_KEY, null) ?: return null
    return try {
      val payload = decode(encoded)
      val ivSize = payload.firstOrNull()?.toInt()?.and(0xff) ?: 0
      require(ivSize in 12..16 && payload.size > ivSize + 1) { "Invalid wrapped key" }
      val iv = payload.copyOfRange(1, 1 + ivSize)
      val encrypted = payload.copyOfRange(1 + ivSize, payload.size)
      val wrappingKey = loadWrappingKey() ?: error("Local wrapping key is unavailable")
      val cipher = Cipher.getInstance(AES_TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, wrappingKey, GCMParameterSpec(GCM_TAG_BITS, iv))
      cipher.doFinal(encrypted).also {
        require(it.size == RECOVERY_KEY_BYTES) { "Invalid recovered key size" }
      }
    } catch (error: Throwable) {
      Log.w(TAG, "Discarding an unreadable local recovery key", error)
      clearLocalRecoveryKey()
      null
    }
  }

  private fun getOrCreateWrappingKey(): SecretKey {
    loadWrappingKey()?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        WRAPPING_KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setKeySize(256)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build(),
    )
    return generator.generateKey()
  }

  private fun loadWrappingKey(): SecretKey? {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    return keyStore.getKey(WRAPPING_KEY_ALIAS, null) as? SecretKey
  }

  @SuppressLint("ApplySharedPref")
  @Synchronized
  private fun clearLocalRecoveryKey() {
    // Persist the clear before deleting the wrapping key to avoid leaving stale vault state.
    preferences.edit(commit = true) { clear() }
    try {
      val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
      if (keyStore.containsAlias(WRAPPING_KEY_ALIAS)) keyStore.deleteEntry(WRAPPING_KEY_ALIAS)
    } catch (error: Throwable) {
      Log.w(TAG, "Could not remove local vault wrapping key", error)
    }
  }

  private fun encrypt(recoveryKey: ByteArray, plaintext: String, credentialId: String): String {
    val cipher = Cipher.getInstance(AES_TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(recoveryKey, KeyProperties.KEY_ALGORITHM_AES))
    cipher.updateAAD(aad(credentialId))
    val encrypted = cipher.doFinal(plaintext.toByteArray(StandardCharsets.UTF_8))
    return "v1.${encode(cipher.iv)}.${encode(encrypted)}"
  }

  private fun decrypt(recoveryKey: ByteArray, value: String, credentialId: String): String {
    val parts = value.split('.')
    require(parts.size == 3 && parts[0] == "v1") { "Unsupported credential backup format" }
    val cipher = Cipher.getInstance(AES_TRANSFORMATION)
    cipher.init(
      Cipher.DECRYPT_MODE,
      SecretKeySpec(recoveryKey, KeyProperties.KEY_ALGORITHM_AES),
      GCMParameterSpec(GCM_TAG_BITS, decode(parts[1])),
    )
    cipher.updateAAD(aad(credentialId))
    return String(cipher.doFinal(decode(parts[2])), StandardCharsets.UTF_8)
  }

  private fun aad(credentialId: String): ByteArray =
    "$CREDENTIAL_AAD_PREFIX:$credentialId".toByteArray(StandardCharsets.UTF_8)

  private fun finishUnlockSuccess() {
    val promise = pendingUnlock
    pendingUnlock = null
    activePrompt = null
    promise?.resolve(true)
  }

  private fun finishUnlockError(code: String, message: String) {
    val promise = pendingUnlock
    pendingUnlock = null
    activePrompt = null
    promise?.reject(code, message)
  }

  private fun finishUnlockError(code: String, error: Throwable) {
    val promise = pendingUnlock
    pendingUnlock = null
    activePrompt = null
    promise?.reject(code, error)
  }

  private fun encode(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING)

  private fun decode(value: String): ByteArray =
    Base64.decode(value, Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING)

  companion object {
    private const val TAG = "HerdrCredentialVault"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val AES_TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    private const val RECOVERY_KEY_BYTES = 32
    private const val LOCAL_PREFERENCES = "herdr_credential_vault_local"
    private const val WRAPPED_RECOVERY_KEY = "wrapped_recovery_key_v1"
    private const val WRAPPING_KEY_ALIAS = "dev.herdr.remote.credential-vault.wrap.v1"
    private const val BLOCK_STORE_KEY = "dev.herdr.remote.credential-vault.recovery.v1"
    private const val CREDENTIAL_AAD_PREFIX = "dev.herdr.remote.credential-backup.v1"
  }
}
