package me.dylankenneally.rnssh;

import android.os.Environment;
import android.util.Log;
import android.util.Base64;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Callback;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.WritableNativeArray;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.ChannelSftp.LsEntry;
import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.SftpException;
import com.jcraft.jsch.SftpProgressMonitor;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import java.util.Vector;
import java.util.concurrent.ConcurrentHashMap;

import org.json.JSONObject;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.Arguments;

import com.jcraft.jsch.KeyPair;

import java.io.File;
import java.io.IOException;
import java.io.ByteArrayOutputStream;

public class RNSshClientModule extends ReactContextBaseJavaModule {
  private static final int SSH_CONNECT_TIMEOUT_MS = 10_000;
  private static final int SSH_CHANNEL_CONNECT_TIMEOUT_MS = 5_000;
  private static final int SSH_SERVER_ALIVE_INTERVAL_MS = 5_000;
  private static final int SSH_SERVER_ALIVE_COUNT_MAX = 3;

  private class HerdrBridgeConnection {
    volatile String terminalId;
    volatile boolean handshakeComplete = false;
    volatile boolean closedByClient = false;
    ChannelExec channel = null;
    DataOutputStream outputStream = null;

    HerdrBridgeConnection(@Nullable String terminalId) {
      this.terminalId = terminalId;
    }
  }

  private class SSHClient {
    Session _session;
    String _key;
    BufferedReader _bufferedReader;
    DataOutputStream _dataOutputStream;
    Channel _channel = null;
    final Map<String, HerdrBridgeConnection> _herdrBridges = new ConcurrentHashMap<>();
    HerdrBridgeConnection _preparedHerdrBridge = null;
    ChannelExec _herdrEventChannel = null;
    DataOutputStream _herdrEventOutputStream = null;
    ChannelSftp _sftpSession = null;
    Boolean _downloadContinue = false;
    Boolean _uploadContinue = false;
  }

  private final ReactApplicationContext reactContext;
  private static final String LOGTAG = "RNSSHClient";
  private static final String DOWNLOAD_PATH = Environment.getExternalStorageDirectory().getPath();

  Map<String, SSHClient> clientPool = new HashMap<>();

  public RNSshClientModule(ReactApplicationContext reactContext) {
    super(reactContext);
    this.reactContext = reactContext;
  }

  @Override
  public String getName() {
    return "RNSSHClient";
  }

  private void sendEvent(ReactContext reactContext,
                         String eventName,
                         @Nullable WritableMap params) {
    reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit(eventName, params);
  }

  @ReactMethod
  private void connectToHostByPassword(final String host, final Integer port, final String username, final String passwordOrKey, final String key, final Callback callback) {
    connectToHost(host, port, username, passwordOrKey, null, key, callback);
  }

  @ReactMethod
  private void connectToHostByKey(final String host, final Integer port, final String username, final ReadableMap passwordOrKey, final String key, final Callback callback) {
    connectToHost(host, port, username, null, passwordOrKey, key, callback);
  }
  private int getKeyTypeFromString(String type) throws IllegalArgumentException {
    if (type == null) {
        throw new IllegalArgumentException("Key type cannot be null");
    }
    switch (type.toLowerCase()) {
        case "dsa":
            return KeyPair.DSA;
        case "rsa":
            return KeyPair.RSA;
        case "ecdsa":
            return KeyPair.ECDSA;
        case "ed25519":
            return KeyPair.ED25519;
        case "ed448":
            return KeyPair.ED448;
        default:
            throw new IllegalArgumentException("Unsupported key type: " + type);
    }
}

  @ReactMethod
  public void generateKeyPair(final String type, @Nullable final String passphrase, final int keySize, final String comment, final Callback callback) {
    new Thread(new Runnable() {
        public void run() {
            try {
                int keyType = getKeyTypeFromString(type); // You'll implement this to translate string to type
                JSch jsch = new JSch();
                KeyPair kpair = KeyPair.genKeyPair(jsch, keyType, keySize);

                // callback.invoke("Finger print: " + kpair.getFingerPrint());
                ByteArrayOutputStream privateKeyOut = new ByteArrayOutputStream();
                ByteArrayOutputStream publicKeyOut = new ByteArrayOutputStream();
                kpair.writePrivateKey(privateKeyOut, passphrase.isEmpty() ? null : passphrase.getBytes());
                kpair.writePublicKey(publicKeyOut, comment);
                String privateKeyString = privateKeyOut.toString("UTF-8");
                String publicKeyString = publicKeyOut.toString("UTF-8");
                WritableMap keyMap = Arguments.createMap();
                keyMap.putString("privateKey", privateKeyString);
                keyMap.putString("publicKey", publicKeyString);
                callback.invoke(null, keyMap);

                privateKeyOut.close();
                publicKeyOut.close();
                kpair.dispose();
            } catch (Exception e) {
                Log.e(LOGTAG, "Failed to generate key pair", e);
                callback.invoke("Failed to generate key pair: " + e.toString());
            }
        }
    }).start();
}

  @ReactMethod
  public void getKeyDetails(String privateKey, Promise promise) {
  try {
    // Parse the key straight from memory. The previous implementation wrote the
    // private key to a temp file on disk, which briefly exposed it and could
    // leak if the process was killed mid-parse (review #3).
    JSch jsch = new JSch();
    KeyPair kpair = KeyPair.load(jsch, privateKey.getBytes(), null);

    String keyType;
    switch (kpair.getKeyType()) {
      case KeyPair.RSA:
        keyType = "RSA";
        break;
      case KeyPair.DSA:
        keyType = "DSA";
        break;
      case KeyPair.ECDSA:
        keyType = "ECDSA";
        break;
      case KeyPair.ED25519:
        keyType = "ED25519";
        break;
      default:
        keyType = "UNKNOWN";
    }
    int keySize = kpair.getKeySize();

    kpair.dispose();

    WritableMap result = Arguments.createMap();
    result.putString("keyType", keyType);
    result.putInt("keySize", keySize);
    promise.resolve(result);
  } catch (Exception e) {
    promise.reject("Error", e.getMessage());
  }
}


  private void connectToHost(final String host, final Integer port, final String username,final String password, final ReadableMap keyPairs, final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          JSch jsch = new JSch();

          if (password == null) {
            byte[] privateKey = keyPairs.getString("privateKey").getBytes();
            byte[] publicKey = keyPairs.hasKey("publicKey") ? keyPairs.getString("publicKey").getBytes() : null;
            byte[] passphrase = keyPairs.hasKey("passphrase") ? keyPairs.getString("passphrase").getBytes() : null;
            jsch.addIdentity("default", privateKey, publicKey, passphrase);
          }

          Session session = jsch.getSession(username, host, port);

          if (password != null)
            session.setPassword(password);

          Properties properties = new Properties();
          properties.setProperty("StrictHostKeyChecking", "no");
          session.setConfig(properties);
          // Without SSH-level probes, a lost mobile network path can leave
          // channel reads blocked forever: the TCP socket still appears open,
          // so the terminal never receives a close event and looks frozen.
          session.setServerAliveInterval(SSH_SERVER_ALIVE_INTERVAL_MS);
          session.setServerAliveCountMax(SSH_SERVER_ALIVE_COUNT_MAX);
          session.connect(SSH_CONNECT_TIMEOUT_MS);

          if (session.isConnected()) {
            SSHClient client = new SSHClient();
            client._session = session;
            client._key = key;
            clientPool.put(key, client);

            Log.d(LOGTAG, "Session connected");
            callback.invoke();
          }
        } catch (JSchException error) {
          Log.e(LOGTAG, "Connection failed: " + error.getMessage());
          callback.invoke(error.getMessage());
        } catch (Exception error) {
          Log.e(LOGTAG, "Connection failed: " + error.getMessage());
          callback.invoke(error.getMessage());
        }
      }
    }).start();
  }


  @ReactMethod
  public void execute(final String command, final String key, final Callback callback) {
    new Thread(new Runnable() {
      public void run() {
        ChannelExec channel = null;
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) {
              throw new Exception("client is null");
          }
          Session session = client._session;

          channel = (ChannelExec) session.openChannel("exec");
          channel.setCommand(command);
          InputStream in = channel.getInputStream();
          channel.connect(SSH_CHANNEL_CONNECT_TIMEOUT_MS);

          String line;
          StringBuilder response = new StringBuilder();
          BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
          while ((line = reader.readLine()) != null) {
            response.append(line).append("\r\n");
          }

          callback.invoke(null, response.toString());
        } catch (JSchException error) {
          Log.e(LOGTAG, "Error executing command: " + error.getMessage());
          callback.invoke(error.getMessage());
        } catch (Exception error) {
          Log.e(LOGTAG, "Error executing command: " + error.getMessage());
          callback.invoke(error.getMessage());
        } finally {
          if (channel != null) channel.disconnect();
        }
      }
    }).start();
  }

  @ReactMethod
  public void startShell(final String key, final String ptyType, final Callback callback) {
    startShellInternal(key, ptyType, false, callback);
  }

  @ReactMethod
  public void startLineShell(final String key, final String ptyType, final Callback callback) {
    startShellInternal(key, ptyType, true, callback);
  }

  private void startShellInternal(final String key, final String ptyType, final boolean lineBuffered, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) {
              throw new Exception("client is null");
          }
          Session session = client._session;

          Channel channel = session.openChannel("shell");
          ((ChannelShell)channel).setPtyType(ptyType);
          channel.connect(SSH_CHANNEL_CONNECT_TIMEOUT_MS);

          InputStream in = channel.getInputStream();
          client._channel = channel;
          client._bufferedReader = new BufferedReader(new InputStreamReader(in));
          client._dataOutputStream = new DataOutputStream(channel.getOutputStream());

          callback.invoke();

          if (lineBuffered) {
            String line;
            while (client._bufferedReader != null && (line = client._bufferedReader.readLine()) != null) {
              sendLineShellEvent(key, line);
            }
          } else {
            char[] chars = new char[8192];
            int charCount;
            while (client._bufferedReader != null && (charCount = client._bufferedReader.read(chars)) != -1) {
              sendShellEvent(key, new String(chars, 0, charCount));
            }
          }

        } catch (JSchException error) {
          Log.e(LOGTAG, "Error starting shell: " + error.getMessage());
          callback.invoke(error.getMessage());
        } catch (IOException error) {
          Log.e(LOGTAG, "Error starting shell: " + error.getMessage());
          callback.invoke(error.getMessage());
        } catch (Exception error) {
          Log.e(LOGTAG, "Error sarting shell: " + error.getMessage());
          callback.invoke(error.getMessage());
        }
      }
    }).start();
  }

  private void sendShellEvent(final String key, final String value) {
    WritableMap map = Arguments.createMap();
    map.putString("name", "Shell");
    map.putString("key", key);
    map.putString("value", value);
    sendEvent(reactContext, "Shell", map);
  }

  private void sendLineShellEvent(final String key, final String line) {
    final int chunkSize = 8192;
    int start = 0;
    while (start < line.length()) {
      int end = Math.min(line.length(), start + chunkSize);
      if (end < line.length() && Character.isHighSurrogate(line.charAt(end - 1))) {
        end -= 1;
      }
      sendShellEvent(key, line.substring(start, end));
      start = end;
    }
    sendShellEvent(key, "\n");
  }

  @ReactMethod
  public void writeToShell(final String str, final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) {
              throw new Exception("client is null");
          }
          client._dataOutputStream.writeBytes(str);
          client._dataOutputStream.flush();
          callback.invoke();
        } catch (IOException error) {
          Log.e(LOGTAG, "Error writing to shell:" + error.getMessage());
          callback.invoke(error.getMessage());
        } catch (Exception error) {
          Log.e(LOGTAG, "Error writing to shell:" + error.getMessage());
          callback.invoke(error.getMessage());
        }
      }
    }).start();
  }

  @ReactMethod
  public void resizeShell(final int columns, final int rows, final String key) {
    new Thread(new Runnable() {
      public void run() {
        SSHClient client = clientPool.get(key);
        if (client == null || !(client._channel instanceof ChannelShell)) {
          return;
        }
        ((ChannelShell) client._channel).setPtySize(columns, rows, 0, 0);
      }
    }).start();
  }

  @ReactMethod
  public void closeShell(final String key) {
    new Thread(new Runnable()  {
      public void run() {
        SSHClient client = clientPool.get(key);
        if (client != null) {
          closeShellClient(client);
        }
      }
    }).start();
  }

  private void closeShellClient(SSHClient client) {
    try {
      if (client._channel != null) {
        client._channel.disconnect();
        client._channel = null;
      }
      if (client._dataOutputStream != null) {
        client._dataOutputStream.flush();
        client._dataOutputStream.close();
        client._dataOutputStream = null;
      }
      if (client._bufferedReader != null) {
        client._bufferedReader.close();
        client._bufferedReader = null;
      }
    } catch (IOException error) {
      Log.e(LOGTAG, "Error closing shell:" + error.getMessage());
    }
  }

  @ReactMethod
  public void prepareHerdrBridge(
      final String command,
      final int protocol,
      final int columns,
      final int rows,
      final int cellWidthPx,
      final int cellHeightPx,
      final String key,
      final Callback callback
  ) {
    new Thread(new Runnable() {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) throw new Exception("client is null");
          HerdrBridgeConnection connection;
          synchronized (client) {
            if (client._preparedHerdrBridge != null) {
              if (
                  client._preparedHerdrBridge.handshakeComplete
                  && bridgeIsConnected(client._preparedHerdrBridge)
              ) {
                callback.invoke();
              } else {
                callback.invoke("Herdr bridge preparation is already in progress");
              }
              return;
            }
            connection = new HerdrBridgeConnection(null);
            client._preparedHerdrBridge = connection;
          }
          runHerdrBridgeConnection(
              client,
              connection,
              command,
              protocol,
              columns,
              rows,
              cellWidthPx,
              cellHeightPx,
              false,
              true,
              key,
              callback
          );
        } catch (Exception error) {
          callback.invoke(error.getMessage());
        }
      }
    }).start();
  }

  @ReactMethod
  public void startHerdrBridge(
      final String command,
      final int protocol,
      final String terminalId,
      final boolean takeover,
      final int columns,
      final int rows,
      final int cellWidthPx,
      final int cellHeightPx,
      final String key,
      final Callback callback
  ) {
    new Thread(new Runnable() {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) throw new Exception("client is null");
          HerdrBridgeConnection existing = client._herdrBridges.get(terminalId);
          if (bridgeIsConnected(existing)) {
            callback.invoke();
            return;
          }

          HerdrBridgeConnection prepared = null;
          synchronized (client) {
            if (
                client._preparedHerdrBridge != null
                && client._preparedHerdrBridge.handshakeComplete
                && bridgeIsConnected(client._preparedHerdrBridge)
            ) {
              prepared = client._preparedHerdrBridge;
              client._preparedHerdrBridge = null;
              prepared.terminalId = terminalId;
              client._herdrBridges.put(terminalId, prepared);
            }
          }
          if (prepared != null) {
            try {
              writeHerdrMessage(prepared, HerdrBridgeCodec.attachTerminal(terminalId, takeover));
              callback.invoke();
            } catch (Exception error) {
              prepared.closedByClient = true;
              client._herdrBridges.remove(terminalId, prepared);
              closeHerdrBridgeConnection(prepared);
              callback.invoke(error.getMessage());
            }
            return;
          }

          HerdrBridgeConnection connection = new HerdrBridgeConnection(terminalId);
          client._herdrBridges.put(terminalId, connection);
          runHerdrBridgeConnection(
              client,
              connection,
              command,
              protocol,
              columns,
              rows,
              cellWidthPx,
              cellHeightPx,
              true,
              takeover,
              key,
              callback
          );
        } catch (Exception error) {
          callback.invoke(error.getMessage());
        }
      }
    }).start();
  }

  private void runHerdrBridgeConnection(
      SSHClient client,
      HerdrBridgeConnection connection,
      String command,
      int protocol,
      int columns,
      int rows,
      int cellWidthPx,
      int cellHeightPx,
      boolean attachAfterHandshake,
      boolean takeover,
      String key,
      Callback callback
  ) {
    boolean callbackInvoked = false;
    try {
      ChannelExec channel = (ChannelExec) client._session.openChannel("exec");
      channel.setCommand(command);
      InputStream input = channel.getInputStream();
      InputStream errorInput = channel.getErrStream();
      DataOutputStream output = new DataOutputStream(channel.getOutputStream());
      connection.channel = channel;
      connection.outputStream = output;
      channel.connect(SSH_CHANNEL_CONNECT_TIMEOUT_MS);
      startHerdrBridgeErrorReader(errorInput, connection);
      writeHerdrMessage(connection, HerdrBridgeCodec.hello(
          protocol,
          columns,
          rows,
          cellWidthPx,
          cellHeightPx
      ));

      while (clientPool.get(key) == client && channel.isConnected()) {
        byte[] payload = readHerdrPayload(input);
        if (payload == null) break;
        HerdrBridgeCodec.Message message = HerdrBridgeCodec.decode(payload);
        if ("welcome".equals(message.type)) {
          if (message.text != null) {
            throw new IOException("Herdr bridge rejected protocol " + protocol + ": " + message.text);
          }
          if (message.sequence != protocol) {
            throw new IOException(
                "Herdr bridge protocol mismatch: expected " + protocol + ", received " + message.sequence
            );
          }
          if (message.width != 1) {
            throw new IOException("Herdr bridge did not negotiate terminal ANSI rendering");
          }
          connection.handshakeComplete = true;
          String terminalId = connection.terminalId;
          if (attachAfterHandshake && terminalId != null) {
            writeHerdrMessage(connection, HerdrBridgeCodec.attachTerminal(terminalId, takeover));
          }
          callback.invoke();
          callbackInvoked = true;
        } else if (connection.handshakeComplete && connection.terminalId != null) {
          sendHerdrBridgeMessage(key, connection.terminalId, message);
        }
      }
      if (!connection.handshakeComplete) {
        boolean clientWasReplaced = clientPool.get(key) != client;
        boolean unusedPrewarm = connection.terminalId == null;
        if (connection.closedByClient || clientWasReplaced || unusedPrewarm) {
          if (!callbackInvoked) {
            callback.invoke(
                unusedPrewarm
                    ? "Herdr bridge prewarm ended before Welcome"
                    : "Herdr bridge cancelled because the SSH session was replaced"
            );
            callbackInvoked = true;
          }
        } else {
          throw new IOException("Herdr bridge closed before Welcome");
        }
      }
      if (!connection.closedByClient && connection.terminalId != null) {
        sendHerdrBridgeClosed(key, connection.terminalId, "Herdr remote-client-bridge closed");
      }
    } catch (Exception error) {
      if (!connection.handshakeComplete && connection.terminalId == null) {
        // Prewarming is opportunistic. Channel pressure or a reconnect may end
        // it without affecting any visible terminal, so do not report it as a
        // terminal bridge failure. The callback still lets JavaScript retry.
        Log.d(LOGTAG, "Herdr bridge prewarm ended: " + error.getMessage());
      } else {
        Log.e(LOGTAG, "Herdr bridge failed: " + error.getMessage());
      }
      if (!callbackInvoked) callback.invoke(error.getMessage());
      else if (!connection.closedByClient && connection.terminalId != null) {
        sendHerdrBridgeClosed(key, connection.terminalId, error.getMessage());
      }
    } finally {
      synchronized (client) {
        if (client._preparedHerdrBridge == connection) client._preparedHerdrBridge = null;
      }
      if (connection.terminalId != null) {
        client._herdrBridges.remove(connection.terminalId, connection);
      }
      closeHerdrBridgeConnection(connection);
    }
  }

  private boolean bridgeIsConnected(@Nullable HerdrBridgeConnection connection) {
    return connection != null
        && connection.channel != null
        && connection.channel.isConnected()
        && connection.outputStream != null;
  }

  @ReactMethod
  public void herdrBridgeInput(final String terminalId, final String text, final String key, final Callback callback) {
    writeHerdrMessageWithCallback(key, terminalId, callback, new HerdrMessageFactory() {
      public byte[] create() throws IOException {
        return HerdrBridgeCodec.input(text);
      }
    });
  }

  @ReactMethod
  public void herdrBridgeResize(
      final int columns,
      final int rows,
      final int cellWidthPx,
      final int cellHeightPx,
      final String terminalId,
      final String key,
      final Callback callback
  ) {
    writeHerdrMessageWithCallback(key, terminalId, callback, new HerdrMessageFactory() {
      public byte[] create() throws IOException {
        return HerdrBridgeCodec.resize(columns, rows, cellWidthPx, cellHeightPx);
      }
    });
  }

  @ReactMethod
  public void herdrBridgeScroll(
      final boolean up,
      final int lines,
      final String terminalId,
      final String key,
      final Callback callback
  ) {
    writeHerdrMessageWithCallback(key, terminalId, callback, new HerdrMessageFactory() {
      public byte[] create() throws IOException {
        return HerdrBridgeCodec.scroll(up, lines);
      }
    });
  }

  @ReactMethod
  public void closeHerdrBridge(final String terminalId, final String key) {
    SSHClient client = clientPool.get(key);
    if (client == null) return;
    HerdrBridgeConnection connection = client._herdrBridges.remove(terminalId);
    if (connection == null) return;
    connection.closedByClient = true;
    try {
      writeHerdrMessage(connection, HerdrBridgeCodec.detach());
    } catch (Exception ignored) {
    }
    closeHerdrBridgeConnection(connection);
  }

  @ReactMethod
  public void closeAllHerdrBridges(final String key) {
    SSHClient client = clientPool.get(key);
    if (client != null) closeHerdrBridgeClient(client);
  }

  private interface HerdrMessageFactory {
    byte[] create() throws IOException;
  }

  private void writeHerdrMessageWithCallback(
      String key,
      String terminalId,
      Callback callback,
      HerdrMessageFactory factory
  ) {
    try {
      SSHClient client = clientPool.get(key);
      if (client == null) throw new IOException("client is null");
      HerdrBridgeConnection connection = client._herdrBridges.get(terminalId);
      if (!bridgeIsConnected(connection)) {
        throw new IOException("Herdr bridge is not active for terminal " + terminalId);
      }
      writeHerdrMessage(connection, factory.create());
      callback.invoke();
    } catch (Exception error) {
      callback.invoke(error.getMessage());
    }
  }

  private void writeHerdrMessage(HerdrBridgeConnection connection, byte[] message) throws IOException {
    synchronized (connection) {
      if (connection.outputStream == null) {
        throw new IOException("Herdr bridge is not active");
      }
      connection.outputStream.write(message);
      connection.outputStream.flush();
    }
  }

  private byte[] readHerdrPayload(InputStream input) throws IOException {
    byte[] lengthBytes = new byte[4];
    int first = input.read();
    if (first < 0) return null;
    lengthBytes[0] = (byte) first;
    readHerdrFully(input, lengthBytes, 1, 3);
    long length = ((long) lengthBytes[0] & 0xffL)
        | (((long) lengthBytes[1] & 0xffL) << 8)
        | (((long) lengthBytes[2] & 0xffL) << 16)
        | (((long) lengthBytes[3] & 0xffL) << 24);
    if (length > HerdrBridgeCodec.MAX_FRAME_SIZE) {
      throw new IOException("Herdr bridge frame exceeds maximum size: " + length);
    }
    byte[] payload = new byte[(int) length];
    readHerdrFully(input, payload, 0, payload.length);
    return payload;
  }

  private void startHerdrBridgeErrorReader(
      final InputStream errorInput,
      final HerdrBridgeConnection connection
  ) {
    new Thread(new Runnable() {
      public void run() {
        try {
          BufferedReader reader = new BufferedReader(new InputStreamReader(errorInput));
          String line;
          while ((line = reader.readLine()) != null) {
            Log.e(LOGTAG, "Herdr bridge stderr [" + connection.terminalId + "]: " + line);
          }
        } catch (IOException error) {
          Log.d(LOGTAG, "Herdr bridge stderr closed [" + connection.terminalId + "]: " + error.getMessage());
        }
      }
    }).start();
  }

  private void readHerdrFully(InputStream input, byte[] target, int offset, int length) throws IOException {
    int complete = 0;
    while (complete < length) {
      int count = input.read(target, offset + complete, length - complete);
      if (count < 0) throw new IOException("unexpected end of Herdr bridge stream");
      complete += count;
    }
  }

  private void sendHerdrBridgeMessage(String key, String terminalId, HerdrBridgeCodec.Message message) {
    if ("terminal".equals(message.type)) {
      byte[] bytes = message.bytes == null ? new byte[0] : message.bytes;
      int chunkSize = 6144;
      if (bytes.length == 0) {
        sendHerdrTerminalChunk(key, terminalId, message, "", true);
        return;
      }
      for (int start = 0; start < bytes.length; start += chunkSize) {
        int length = Math.min(chunkSize, bytes.length - start);
        String encoded = Base64.encodeToString(bytes, start, length, Base64.NO_WRAP);
        sendHerdrTerminalChunk(key, terminalId, message, encoded, start + length >= bytes.length);
      }
      return;
    }

    WritableMap value = Arguments.createMap();
    value.putString("type", message.type);
    value.putString("terminalId", terminalId);
    if (message.text != null) value.putString("text", message.text);
    if (message.body != null) value.putString("body", message.body);
    value.putBoolean("flag", message.flag);
    value.putInt("kind", message.width);
    sendHerdrBridgeEvent(key, value);
  }

  private void sendHerdrTerminalChunk(
      String key,
      String terminalId,
      HerdrBridgeCodec.Message message,
      String bytes,
      boolean finalChunk
  ) {
    WritableMap value = Arguments.createMap();
    value.putString("type", "terminal");
    value.putString("terminalId", terminalId);
    value.putDouble("seq", (double) message.sequence);
    value.putInt("width", message.width);
    value.putInt("height", message.height);
    value.putBoolean("full", message.flag);
    value.putString("bytes", bytes);
    value.putBoolean("final", finalChunk);
    sendHerdrBridgeEvent(key, value);
  }

  private void sendHerdrBridgeClosed(String key, String terminalId, String reason) {
    WritableMap value = Arguments.createMap();
    value.putString("type", "closed");
    value.putString("terminalId", terminalId);
    value.putString("text", reason == null ? "Herdr bridge closed" : reason);
    sendHerdrBridgeEvent(key, value);
  }

  private void sendHerdrBridgeEvent(String key, WritableMap value) {
    WritableMap event = Arguments.createMap();
    event.putString("name", "HerdrBridge");
    event.putString("key", key);
    event.putMap("value", value);
    sendEvent(reactContext, "HerdrBridge", event);
  }

  private void closeHerdrBridgeClient(SSHClient client) {
    HerdrBridgeConnection prepared;
    synchronized (client) {
      prepared = client._preparedHerdrBridge;
      client._preparedHerdrBridge = null;
    }
    if (prepared != null) {
      prepared.closedByClient = true;
      closeHerdrBridgeConnection(prepared);
    }
    for (HerdrBridgeConnection connection : client._herdrBridges.values()) {
      connection.closedByClient = true;
      closeHerdrBridgeConnection(connection);
    }
    client._herdrBridges.clear();
  }

  private void closeHerdrBridgeConnection(HerdrBridgeConnection connection) {
    synchronized (connection) {
      try {
        if (connection.outputStream != null) {
          connection.outputStream.flush();
          connection.outputStream.close();
          connection.outputStream = null;
        }
      } catch (IOException error) {
        Log.e(LOGTAG, "Error closing Herdr bridge output: " + error.getMessage());
      }
      if (connection.channel != null) {
        connection.channel.disconnect();
        connection.channel = null;
      }
    }
  }

  @ReactMethod
  public void startHerdrEventStream(
      final String command,
      final String key,
      final Callback callback
  ) {
    new Thread(new Runnable() {
      public void run() {
        boolean started = false;
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) throw new Exception("client is null");
          if (client._herdrEventChannel != null && client._herdrEventChannel.isConnected()) {
            callback.invoke();
            return;
          }
          ChannelExec channel = (ChannelExec) client._session.openChannel("exec");
          channel.setCommand(command);
          InputStream input = channel.getInputStream();
          DataOutputStream output = new DataOutputStream(channel.getOutputStream());
          client._herdrEventChannel = channel;
          client._herdrEventOutputStream = output;
          channel.connect(SSH_CHANNEL_CONNECT_TIMEOUT_MS);
          started = true;
          callback.invoke();

          InputStreamReader reader = new InputStreamReader(input, StandardCharsets.UTF_8);
          char[] chars = new char[8192];
          int count;
          while (clientPool.get(key) == client && channel.isConnected() && (count = reader.read(chars)) >= 0) {
            if (count > 0) sendHerdrEventStreamData(key, new String(chars, 0, count));
          }
          sendHerdrEventStreamData(key, "{\"herdr_android_bridge_closed\":true}\n");
        } catch (Exception error) {
          Log.e(LOGTAG, "Herdr event stream failed: " + error.getMessage());
          if (!started) callback.invoke(error.getMessage());
          else sendHerdrEventStreamData(key, "{\"herdr_android_bridge_closed\":true}\n");
        } finally {
          SSHClient client = clientPool.get(key);
          if (client != null) closeHerdrEventStreamClient(client);
        }
      }
    }).start();
  }

  @ReactMethod
  public void writeHerdrEventStream(final String value, final String key, final Callback callback) {
    try {
      SSHClient client = clientPool.get(key);
      if (client == null) throw new IOException("client is null");
      synchronized (client) {
        if (client._herdrEventOutputStream == null) throw new IOException("Herdr event stream is not active");
        client._herdrEventOutputStream.write(value.getBytes(StandardCharsets.UTF_8));
        client._herdrEventOutputStream.flush();
      }
      callback.invoke();
    } catch (Exception error) {
      callback.invoke(error.getMessage());
    }
  }

  @ReactMethod
  public void closeHerdrEventStream(final String key) {
    SSHClient client = clientPool.get(key);
    if (client != null) closeHerdrEventStreamClient(client);
  }

  private void sendHerdrEventStreamData(String key, String value) {
    WritableMap event = Arguments.createMap();
    event.putString("name", "HerdrEventStream");
    event.putString("key", key);
    event.putString("value", value);
    sendEvent(reactContext, "HerdrEventStream", event);
  }

  private void closeHerdrEventStreamClient(SSHClient client) {
    synchronized (client) {
      try {
        if (client._herdrEventOutputStream != null) {
          client._herdrEventOutputStream.flush();
          client._herdrEventOutputStream.close();
          client._herdrEventOutputStream = null;
        }
      } catch (IOException error) {
        Log.e(LOGTAG, "Error closing Herdr event output: " + error.getMessage());
      }
      if (client._herdrEventChannel != null) {
        client._herdrEventChannel.disconnect();
        client._herdrEventChannel = null;
      }
    }
  }

  @ReactMethod
  public void connectSFTP(final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) {
              throw new Exception("client is null");
          }
          ChannelSftp channelSftp = (ChannelSftp) client._session.openChannel("sftp");
          channelSftp.connect();
          client._sftpSession = channelSftp;
          callback.invoke();
        } catch (JSchException error) {
          Log.e(LOGTAG, "Error connecting SFTP:" + error.getMessage());
          callback.invoke(error.getMessage());
        } catch (Exception error) {
          Log.e(LOGTAG, "Error connecting SFTP:" + error.getMessage());
          callback.invoke(error.getMessage());
        }
      }
    }).start();
  }

  @ReactMethod
  public void disconnectSFTP(final String key) {
    new Thread(new Runnable()  {
      public void run() {
        SSHClient client = clientPool.get(key);
        if (client == null) {
            return;
        }
        if (client._sftpSession != null) {
          client._sftpSession.disconnect();
        }
      }
    }).start();
  }

  @ReactMethod
  public void sftpLs(final String path, final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
        if (client == null) {
            throw new Exception("client is null");
        }
          ChannelSftp channelSftp = client._sftpSession;

          Vector<LsEntry> files = channelSftp.ls(path);
          WritableArray response = new WritableNativeArray();

          for (LsEntry file: files) {
            int isDir = 0;
            String filename = file.getFilename();
            if (filename.trim().equals(".") || filename.trim().equals(".."))
              continue;

            if (file.getAttrs().isDir()) {
              isDir = 1;
              filename += '/';
            }
            // Build the entry with a real JSON serializer so filenames containing
            // quotes, backslashes, control characters, or unicode are escaped
            // correctly (manual string formatting produced invalid JSON, review #7).
            // Field types are preserved to match the previous output: dates and
            // permissions are strings, the rest are numbers.
            JSONObject entry = new JSONObject();
            entry.put("filename", filename);
            entry.put("isDirectory", isDir);
            entry.put("modificationDate", String.valueOf(file.getAttrs().getMTime()));
            entry.put("lastAccess", String.valueOf(file.getAttrs().getATime()));
            entry.put("fileSize", file.getAttrs().getSize());
            entry.put("ownerUserID", file.getAttrs().getUId());
            entry.put("ownerGroupID", file.getAttrs().getGId());
            entry.put("permissions", String.valueOf(file.getAttrs().getPermissions()));
            entry.put("flags", file.getAttrs().getFlags());
            response.pushString(entry.toString());
          }
          callback.invoke(null, response);
        } catch (SftpException error) {
          Log.e(LOGTAG, "Failed to list path " + path);
          callback.invoke("Failed to list path " + path);
        } catch (Exception error) {
          Log.e(LOGTAG, "Failed to list path " + path);
          callback.invoke("Failed to list path " + path);
        }
      }
    }).start();
  }

  @ReactMethod
  public void sftpRename(final String oldPath, final String newPath, final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) {
              throw new Exception("client is null");
          }
          ChannelSftp channelSftp = client._sftpSession;
          channelSftp.rename(oldPath, newPath);
          callback.invoke();
        } catch (SftpException error) {
          Log.e(LOGTAG, "Failed to rename path " + oldPath);
          callback.invoke("Failed to rename path " + oldPath);
        } catch (Exception error) {
          Log.e(LOGTAG, "Failed to rename path " + oldPath);
          callback.invoke("Failed to rename path " + oldPath);
        }
      }
    }).start();
  }

  @ReactMethod
  public void sftpMkdir(final String path, final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) {
              throw new Exception("client is null");
          }
          ChannelSftp channelSftp = client._sftpSession;
          channelSftp.mkdir(path);
          callback.invoke();
        } catch (SftpException error) {
          Log.e(LOGTAG, "Failed to create directory " + path);
          callback.invoke("Failed to create directory " + path);
        } catch (Exception error) {
          Log.e(LOGTAG, "Failed to create directory " + path);
          callback.invoke("Failed to create directory " + path);
        }
      }
    }).start();
  }

  @ReactMethod
  public void sftpRm(final String path, final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) {
              throw new Exception("client is null");
          }
          ChannelSftp channelSftp = client._sftpSession;
          channelSftp.rm(path);
          callback.invoke();
        } catch (SftpException error) {
          Log.e(LOGTAG, "Failed to remove " + path);
          callback.invoke("Failed to remove " + path);
        } catch (Exception error) {
          Log.e(LOGTAG, "Failed to remove " + path);
          callback.invoke("Failed to remove " + path);
        }
      }
    }).start();
  }

  @ReactMethod
  public void sftpRmdir(final String path, final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) {
              throw new Exception("client is null");
          }
          ChannelSftp channelSftp = client._sftpSession;
          channelSftp.rmdir(path);
          callback.invoke();
        } catch (SftpException error) {
          Log.e(LOGTAG, "Failed to remove " + path);
          callback.invoke("Failed to remove " + path);
        } catch (Exception error) {
          Log.e(LOGTAG, "Failed to remove " + path);
          callback.invoke("Failed to remove " + path);
        }
      }
    }).start();
  }

  @ReactMethod
  public void sftpChmod(final String path, final int permissions, final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) {
              throw new Exception("client is null");
          }
          ChannelSftp channelSftp = client._sftpSession;
          channelSftp.chmod(permissions, path);
          callback.invoke();
        } catch (SftpException error) {
          final String msg = "Failed to chmod " + path + " with permissions " + permissions;
          Log.e(LOGTAG, msg);
          callback.invoke(msg);
        } catch (Exception error) {
          final String msg = "Failed to chmod " + path + " with permissions " + permissions;
          Log.e(LOGTAG, msg);
          callback.invoke(msg);
        }
      }
    }).start();
  }

  @ReactMethod
  public void sftpDownload(final String filePath, final String path, final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) {
              throw new Exception("client is null");
          }
          client._downloadContinue = true;
          ChannelSftp channelSftp = client._sftpSession;
          channelSftp.get(filePath, path, new progressMonitor(key, "DownloadProgress"));
          callback.invoke(null, path + '/' + (new File(filePath)).getName());
        } catch (SftpException error) {
          Log.e(LOGTAG, "Failed to download " + filePath);
          callback.invoke("Failed to download " + filePath);
        } catch (Exception error) {
          Log.e(LOGTAG, "Failed to download " + filePath);
          callback.invoke("Failed to download " + filePath);
        }
      }
    }).start();
  }

  @ReactMethod
  public void sftpUpload(final String filePath, final String path, final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) {
              throw new Exception("client is null");
          }
          client._uploadContinue = true;
          ChannelSftp channelSftp = client._sftpSession;
          channelSftp.put(filePath, path + '/' + (new File(filePath)).getName(), new progressMonitor(key, "UploadProgress"), ChannelSftp.OVERWRITE);
          callback.invoke();
        } catch (SftpException error) {
          Log.e(LOGTAG, "Failed to upload " + filePath);
          callback.invoke("Failed to upload " + filePath);
        } catch (Exception error) {
          Log.e(LOGTAG, "Failed to upload " + filePath);
          callback.invoke("Failed to upload " + filePath);
        }
      }
    }).start();
  }

  @ReactMethod
  public void sftpCancelDownload(final String key) {
    SSHClient client = clientPool.get(key);
    if (client != null) {
        client._downloadContinue = false;
    }
  }

  @ReactMethod
  public void sftpCancelUpload(final String key) {
    SSHClient client = clientPool.get(key);
    if (client != null) {
        client._uploadContinue = false;
    }
  }

  @ReactMethod
  public void disconnect(final String key) {
    SSHClient client = clientPool.remove(key);
    if (client != null) {
        closeShellClient(client);
        closeHerdrBridgeClient(client);
        closeHerdrEventStreamClient(client);
        if (client._sftpSession != null) {
          client._sftpSession.disconnect();
          client._sftpSession = null;
        }
        client._session.disconnect();
    }
  }

  private class progressMonitor implements SftpProgressMonitor {
    private long max = 0;
    private long count = 0;
    private long downloadedPerc = 0;
    private String key;
    private String name;

    public progressMonitor(String key, String name) {
      this.key = key;
      this.name = name;
    }

    public void init(int arg0, String arg1, String arg2, long arg3) {
        this.max = arg3;
    }

    public boolean count(long arg0) {
      SSHClient client = clientPool.get(this.key);
      this.count += arg0;
      long newPerc = this.count * 100 / max;
      if(newPerc % 5 == 0 && newPerc > this.downloadedPerc) {
        this.downloadedPerc = newPerc;
        WritableMap map = Arguments.createMap();
        map.putString("name", this.name);
        map.putString("key", this.key);
        map.putString("value", Long.toString(this.downloadedPerc));
        sendEvent(reactContext, this.name, map);
      }
      boolean con;
      if (this.name.equals("DownloadProgress")) {
        con = client._downloadContinue;
      } else {
        con = client._uploadContinue;
      }
      return con;
    }

    public void end() {
    }
  }

  @ReactMethod
  public void addListener(String eventName) {
    // Keep: Required for RN built in Event Emitter Calls.
  }

  @ReactMethod
  public void removeListeners(Integer count) {
    // Keep: Required for RN built in Event Emitter Calls.
  }
}
