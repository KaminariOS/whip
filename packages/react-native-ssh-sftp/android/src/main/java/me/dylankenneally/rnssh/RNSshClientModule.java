package me.dylankenneally.rnssh;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
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
import com.jcraft.jsch.ChannelDirectStreamLocal;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.ChannelSftp.LsEntry;
import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.Proxy;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.SocketFactory;
import com.jcraft.jsch.SftpException;
import com.jcraft.jsch.SftpProgressMonitor;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.IDN;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
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
    ChannelDirectStreamLocal channel = null;
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
    ChannelDirectStreamLocal _herdrEventChannel = null;
    DataOutputStream _herdrEventOutputStream = null;
    ChannelExec _herdrCommandChannel = null;
    DataOutputStream _herdrCommandOutputStream = null;
    ChannelSftp _sftpSession = null;
    volatile boolean _forwardAgent = false;
    Boolean _downloadContinue = false;
    Boolean _uploadContinue = false;
  }

  private static class AndroidHostResolver {
    @Nullable
    private final Network network;
    @Nullable
    private final String searchDomains;
    private final List<InetAddress> dnsServers;

    AndroidHostResolver(
        @Nullable Network network,
        @Nullable String searchDomains,
        List<InetAddress> dnsServers
    ) {
      this.network = network;
      this.searchDomains = searchDomains;
      this.dnsServers = dnsServers;
    }

    InetAddress resolve(String host) throws IOException {
      Log.d(LOGTAG, "Resolving " + host + " on Android network " + network);
      IOException firstError = null;
      List<String> candidates = new ArrayList<>();
      if (!host.contains(".") && !host.contains(":") && searchDomains != null) {
        for (String domain : searchDomains.trim().split("\\s+")) {
          if (!domain.isEmpty()) candidates.add(host + "." + domain);
        }
      }
      candidates.add(host);

      for (String candidate : candidates) {
        try {
          InetAddress[] addresses = resolveAll(candidate);
          if (addresses.length > 0) {
            return addresses[0];
          }
        } catch (IOException error) {
          if (firstError == null) firstError = error;
        }
      }

      // Some native SSH clients can still resolve through a VPN when Android's
      // Java resolver returns UnknownHostException. Query the DNS servers
      // exposed by that VPN directly so JSch gets the same address.
      for (String candidate : candidates) {
        for (InetAddress dnsServer : dnsServers) {
          try {
            InetAddress address = resolveViaDns(candidate, dnsServer);
            if (address != null) return address;
          } catch (IOException ignored) {
            // Continue through the remaining VPN DNS servers and candidates.
          }
        }
      }

      if (firstError != null) throw firstError;
      throw new IOException("No addresses found for " + host);
    }

    private InetAddress[] resolveAll(String host) throws IOException {
      return network != null
          ? network.getAllByName(host)
          : InetAddress.getAllByName(host);
    }

    @Nullable
    private InetAddress resolveViaDns(String host, InetAddress dnsServer) throws IOException {
      byte[] query = dnsQuery(host);
      int queryId = unsigned16(query, 0);
      byte[] response = new byte[1500];
      DatagramPacket request = new DatagramPacket(query, query.length, dnsServer, 53);
      DatagramPacket reply = new DatagramPacket(response, response.length);

      try (DatagramSocket socket = new DatagramSocket()) {
        if (network != null) network.bindSocket(socket);
        socket.connect(dnsServer, 53);
        socket.setSoTimeout(3_000);
        socket.send(request);
        socket.receive(reply);
      }

      int length = reply.getLength();
      if (length < 12 || unsigned16(response, 0) != queryId || (unsigned16(response, 2) & 0x000f) != 0) {
        return null;
      }
      int offset = 12;
      int questionCount = unsigned16(response, 4);
      int answerCount = unsigned16(response, 6);
      for (int i = 0; i < questionCount; i++) {
        offset = skipDnsName(response, offset, length) + 4;
        if (offset > length) return null;
      }
      for (int i = 0; i < answerCount; i++) {
        offset = skipDnsName(response, offset, length);
        if (offset + 10 > length) return null;
        int type = unsigned16(response, offset);
        int dataLength = unsigned16(response, offset + 8);
        offset += 10;
        if (offset + dataLength > length) return null;
        if (type == 1 && dataLength == 4) {
          byte[] address = new byte[4];
          System.arraycopy(response, offset, address, 0, 4);
          return InetAddress.getByAddress(host, address);
        }
        offset += dataLength;
      }
      return null;
    }

    private static byte[] dnsQuery(String host) throws IOException {
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      int queryId = (int) (System.nanoTime() & 0xffff);
      writeUnsigned16(output, queryId);
      writeUnsigned16(output, 0x0100);
      writeUnsigned16(output, 1);
      writeUnsigned16(output, 0);
      writeUnsigned16(output, 0);
      writeUnsigned16(output, 0);
      for (String label : IDN.toASCII(host).split("\\.")) {
        byte[] bytes = label.getBytes(StandardCharsets.US_ASCII);
        if (bytes.length == 0 || bytes.length > 63) {
          throw new IOException("Invalid DNS name: " + host);
        }
        output.write(bytes.length);
        output.write(bytes);
      }
      output.write(0);
      writeUnsigned16(output, 1);
      writeUnsigned16(output, 1);
      return output.toByteArray();
    }

    private static void writeUnsigned16(ByteArrayOutputStream output, int value) {
      output.write((value >>> 8) & 0xff);
      output.write(value & 0xff);
    }

    private static int unsigned16(byte[] bytes, int offset) {
      return ((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff);
    }

    private static int skipDnsName(byte[] bytes, int offset, int length) throws IOException {
      while (offset < length) {
        int labelLength = bytes[offset] & 0xff;
        if ((labelLength & 0xc0) == 0xc0) {
          if (offset + 1 >= length) throw new IOException("Invalid compressed DNS name");
          return offset + 2;
        }
        offset += 1;
        if (labelLength == 0) return offset;
        offset += labelLength;
      }
      throw new IOException("Invalid DNS name");
    }
  }

  private static class JumpHostProxy implements Proxy {
    private final Session jumpSession;
    private Channel channel;
    private InputStream inputStream;
    private OutputStream outputStream;

    JumpHostProxy(Session jumpSession) {
      this.jumpSession = jumpSession;
    }

    @Override
    public void connect(SocketFactory socketFactory, String host, int port, int timeout) throws Exception {
      if (jumpSession == null || !jumpSession.isConnected()) {
        throw new JSchException("Jump host SSH connection is not active");
      }
      // Match OpenSSH ProxyJump: pass the destination hostname through the
      // direct-tcpip request and let the jump server resolve it.
      Channel nextChannel = jumpSession.getStreamForwarder(host, port);
      try {
        InputStream nextInputStream = nextChannel.getInputStream();
        OutputStream nextOutputStream = nextChannel.getOutputStream();
        nextChannel.connect(timeout);
        channel = nextChannel;
        inputStream = nextInputStream;
        outputStream = nextOutputStream;
      } catch (Exception error) {
        nextChannel.disconnect();
        throw error;
      }
    }

    @Override
    public InputStream getInputStream() {
      return inputStream;
    }

    @Override
    public OutputStream getOutputStream() {
      return outputStream;
    }

    @Override
    public Socket getSocket() {
      return null;
    }

    @Override
    public void close() {
      if (channel != null) {
        channel.disconnect();
        channel = null;
      }
      inputStream = null;
      outputStream = null;
    }
  }

  private final ReactApplicationContext reactContext;
  private static final String LOGTAG = "RNSSHClient";
  private static final String DOWNLOAD_PATH = Environment.getExternalStorageDirectory().getPath();

  Map<String, SSHClient> clientPool = new HashMap<>();
  private volatile String knownHosts = "";

  public RNSshClientModule(ReactApplicationContext reactContext) {
    super(reactContext);
    this.reactContext = reactContext;
  }

  @Nullable
  private Network getSshNetwork(ConnectivityManager connectivityManager) {
    Network activeNetwork = connectivityManager.getActiveNetwork();
    for (Network network : connectivityManager.getAllNetworks()) {
      NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
      if (
          capabilities != null
          && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
          && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      ) {
        return network;
      }
    }
    return activeNetwork;
  }

  private AndroidHostResolver createHostResolver() {
    ConnectivityManager connectivityManager = (ConnectivityManager)
        reactContext.getSystemService(Context.CONNECTIVITY_SERVICE);
    Network network = connectivityManager != null
        ? getSshNetwork(connectivityManager)
        : null;
    LinkProperties linkProperties = connectivityManager != null && network != null
        ? connectivityManager.getLinkProperties(network)
        : null;
    return new AndroidHostResolver(
        network,
        linkProperties != null ? linkProperties.getDomains() : null,
        linkProperties != null ? linkProperties.getDnsServers() : Collections.emptyList()
    );
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
    connectToHost(host, port, username, passwordOrKey, null, null, key, callback);
  }

  @ReactMethod
  private void connectToHostByKey(final String host, final Integer port, final String username, final ReadableMap passwordOrKey, final String key, final Callback callback) {
    connectToHost(host, port, username, null, passwordOrKey, null, key, callback);
  }

  @ReactMethod
  private void connectToHostByPasswordViaJump(final String host, final Integer port, final String username, final String passwordOrKey, final String jumpKey, final String key, final Callback callback) {
    connectToHost(host, port, username, passwordOrKey, null, jumpKey, key, callback);
  }

  @ReactMethod
  private void connectToHostByKeyViaJump(final String host, final Integer port, final String username, final ReadableMap passwordOrKey, final String jumpKey, final String key, final Callback callback) {
    connectToHost(host, port, username, null, passwordOrKey, jumpKey, key, callback);
  }

  @ReactMethod
  public void setAgentForwarding(final String key, final boolean enabled) {
    SSHClient client = clientPool.get(key);
    if (client != null) {
      client._forwardAgent = enabled;
    }
  }

  @ReactMethod
  public void setKnownHosts(final String value) {
    knownHosts = value != null ? value : "";
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
            KeyPair kpair = null;
            try {
                int keyType = getKeyTypeFromString(type); // You'll implement this to translate string to type
                JSch jsch = new JSch();
                kpair = KeyPair.genKeyPair(jsch, keyType, keySize);

                // callback.invoke("Finger print: " + kpair.getFingerPrint());
                ByteArrayOutputStream privateKeyOut = new ByteArrayOutputStream();
                ByteArrayOutputStream publicKeyOut = new ByteArrayOutputStream();
                byte[] passphraseBytes = passphrase == null || passphrase.isEmpty()
                    ? null
                    : passphrase.getBytes(StandardCharsets.UTF_8);
                String keyComment = comment == null || comment.trim().isEmpty() ? "herdr" : comment;
                kpair.setPublicKeyComment(keyComment);
                if (keyType == KeyPair.ED25519 || keyType == KeyPair.ED448) {
                    // EdDSA keys do not have the legacy PEM representation used
                    // by writePrivateKey(). JSch deliberately throws from that
                    // path, so serialize them in the supported OpenSSH v1 format.
                    kpair.writeOpenSSHv1PrivateKey(privateKeyOut, passphraseBytes);
                } else {
                    kpair.writePrivateKey(privateKeyOut, passphraseBytes);
                }
                kpair.writePublicKey(publicKeyOut, keyComment);
                String privateKeyString = privateKeyOut.toString("UTF-8");
                String publicKeyString = publicKeyOut.toString("UTF-8");
                WritableMap keyMap = Arguments.createMap();
                keyMap.putString("privateKey", privateKeyString);
                keyMap.putString("publicKey", publicKeyString);
                callback.invoke(null, keyMap);

                privateKeyOut.close();
                publicKeyOut.close();
            } catch (Exception e) {
                Log.e(LOGTAG, "Failed to generate key pair", e);
                callback.invoke("Failed to generate key pair: " + e.toString());
            } finally {
                if (kpair != null) kpair.dispose();
            }
        }
    }).start();
}

  @ReactMethod
  public void getKeyDetails(String privateKey, @Nullable String passphrase, Promise promise) {
  KeyPair kpair = null;
  try {
    // Parse the key straight from memory. The previous implementation wrote the
    // private key to a temp file on disk, which briefly exposed it and could
    // leak if the process was killed mid-parse (review #3).
    JSch jsch = new JSch();
    kpair = KeyPair.load(jsch, privateKey.getBytes(StandardCharsets.UTF_8), null);

    if (kpair.isEncrypted()) {
      if (passphrase == null || passphrase.isEmpty()) {
        promise.reject("E_KEY_PASSPHRASE_REQUIRED", "Private key passphrase is required");
        return;
      }
      if (!kpair.decrypt(passphrase.getBytes(StandardCharsets.UTF_8))) {
        promise.reject("E_KEY_PASSPHRASE_INVALID", "Private key passphrase is incorrect");
        return;
      }
    }

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
    String fingerprint = kpair.getFingerPrint();
    ByteArrayOutputStream publicKeyOut = new ByteArrayOutputStream();
    kpair.writePublicKey(publicKeyOut, "herdr");

    WritableMap result = Arguments.createMap();
    result.putString("keyType", keyType);
    result.putInt("keySize", keySize);
    result.putString("fingerprint", fingerprint);
    result.putString("publicKey", publicKeyOut.toString("UTF-8").trim());
    promise.resolve(result);
  } catch (Exception e) {
    promise.reject("E_KEY_INVALID", e.getMessage(), e);
  } finally {
    if (kpair != null) kpair.dispose();
  }
}


  private void connectToHost(final String host, final Integer port, final String username, final String password, final ReadableMap keyPairs, @Nullable final String jumpKey, final String key, final Callback callback) {
    new Thread(new Runnable()  {
      public void run() {
        JSch jsch = new JSch();
        Session session = null;
        try {
          jsch.setKnownHosts(new ByteArrayInputStream(knownHosts.getBytes(StandardCharsets.UTF_8)));

          if (password == null) {
            byte[] privateKey = keyPairs.getString("privateKey").getBytes();
            byte[] publicKey = keyPairs.hasKey("publicKey") ? keyPairs.getString("publicKey").getBytes() : null;
            byte[] passphrase = keyPairs.hasKey("passphrase") ? keyPairs.getString("passphrase").getBytes() : null;
            jsch.addIdentity("default", privateKey, publicKey, passphrase);
          }

          AndroidHostResolver resolver = createHostResolver();
          // A proxied session must retain the hostname so the jump server gets
          // the first opportunity to resolve it, matching OpenSSH ProxyJump.
          // Direct sessions still resolve through Android's selected VPN.
          String connectionHost = jumpKey != null
              ? host
              : resolver.resolve(host).getHostAddress();
          session = jsch.getSession(username, connectionHost, port);
          session.setHostKeyAlias(hostKeyAlias(host, port));
          if (password != null)
            session.setPassword(password);

          if (jumpKey != null) {
            SSHClient jumpClient = clientPool.get(jumpKey);
            if (jumpClient == null || jumpClient._session == null || !jumpClient._session.isConnected()) {
              throw new JSchException("Jump host SSH connection is not active");
            }
            session.setProxy(new JumpHostProxy(jumpClient._session));
          }

          Properties properties = new Properties();
          properties.setProperty("StrictHostKeyChecking", "yes");
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
          callback.invoke(hostKeyError(error, session, host, port));
        } catch (Exception error) {
          Log.e(LOGTAG, "Connection failed: " + error.getMessage());
          callback.invoke(error.getMessage());
        }
      }
    }).start();
  }

  private String hostKeyAlias(String host, int port) {
    String normalized = host.trim().toLowerCase(Locale.ROOT);
    return port == 22 ? normalized : "[" + normalized + "]:" + port;
  }

  private String hostKeyError(JSchException error, @Nullable Session session, String host, int port) {
    String message = error.getMessage();
    HostKey hostKey = session != null ? session.getHostKey() : null;
    if (hostKey == null || message == null) return message;

    boolean unknown = message.contains("reject HostKey");
    boolean changed = message.contains("HostKey has been changed");
    if (!unknown && !changed) return message;

    try {
      JSONObject payload = new JSONObject();
      payload.put("host", host.trim().toLowerCase(Locale.ROOT));
      payload.put("port", port);
      payload.put("keyType", hostKey.getType());
      payload.put("publicKey", hostKey.getKey());
      payload.put("fingerprint", sha256Fingerprint(hostKey.getKey()));
      return (unknown ? "E_HOST_KEY_UNKNOWN:" : "E_HOST_KEY_CHANGED:") + payload;
    } catch (Exception payloadError) {
      Log.e(LOGTAG, "Failed to describe SSH host key: " + payloadError.getMessage());
      return message;
    }
  }

  private String sha256Fingerprint(String publicKey) throws Exception {
    byte[] keyBytes = Base64.decode(publicKey, Base64.DEFAULT);
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(keyBytes);
    return "SHA256:" + Base64.encodeToString(
        digest,
        Base64.NO_WRAP | Base64.NO_PADDING
    );
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
          channel.setAgentForwarding(client._forwardAgent);
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

          ChannelShell channel = (ChannelShell) session.openChannel("shell");
          channel.setAgentForwarding(client._forwardAgent);
          channel.setPtyType(ptyType);
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
      final String socketPath,
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
              socketPath,
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
      String socketPath,
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
      ChannelDirectStreamLocal channel = (ChannelDirectStreamLocal) client._session.openChannel(
          "direct-streamlocal@openssh.com"
      );
      channel.setSocketPath(socketPath);
      InputStream input = channel.getInputStream();
      DataOutputStream output = new DataOutputStream(channel.getOutputStream());
      connection.channel = channel;
      connection.outputStream = output;
      channel.connect(SSH_CHANNEL_CONNECT_TIMEOUT_MS);
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
        HerdrBridgeCodec.Message message = HerdrBridgeCodec.decode(payload, protocol);
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
      final String socketPath,
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
          ChannelDirectStreamLocal channel = (ChannelDirectStreamLocal) client._session.openChannel(
              "direct-streamlocal@openssh.com"
          );
          channel.setSocketPath(socketPath);
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
  public void requestHerdrApi(
      final String socketPath,
      final String request,
      final String key,
      final Callback callback
  ) {
    new Thread(new Runnable() {
      public void run() {
        ChannelDirectStreamLocal channel = null;
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) throw new Exception("client is null");
          channel = (ChannelDirectStreamLocal) client._session.openChannel(
              "direct-streamlocal@openssh.com"
          );
          channel.setSocketPath(socketPath);
          InputStream input = channel.getInputStream();
          DataOutputStream output = new DataOutputStream(channel.getOutputStream());
          channel.connect(SSH_CHANNEL_CONNECT_TIMEOUT_MS);
          output.write(request.getBytes(StandardCharsets.UTF_8));
          output.flush();

          BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8));
          String response = reader.readLine();
          if (response == null) throw new IOException("Herdr API socket closed without a response");
          callback.invoke(null, response);
        } catch (Exception error) {
          callback.invoke(error.getMessage(), null);
        } finally {
          if (channel != null) channel.disconnect();
        }
      }
    }).start();
  }

  @ReactMethod
  public void getRemoteHome(final String key, final Callback callback) {
    new Thread(new Runnable() {
      public void run() {
        ChannelSftp channel = null;
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) throw new Exception("client is null");
          channel = (ChannelSftp) client._session.openChannel("sftp");
          channel.connect(SSH_CHANNEL_CONNECT_TIMEOUT_MS);
          callback.invoke(null, channel.pwd());
        } catch (Exception error) {
          callback.invoke(error.getMessage(), null);
        } finally {
          if (channel != null) channel.disconnect();
        }
      }
    }).start();
  }

  @ReactMethod
  public void startHerdrCommandStream(
      final String command,
      final String key,
      final Callback callback
  ) {
    new Thread(new Runnable() {
      public void run() {
        boolean started = false;
        ChannelExec channel = null;
        DataOutputStream output = null;
        try {
          SSHClient client = clientPool.get(key);
          if (client == null) throw new Exception("client is null");
          if (client._herdrCommandChannel != null && client._herdrCommandChannel.isConnected()) {
            callback.invoke();
            return;
          }
          channel = (ChannelExec) client._session.openChannel("exec");
          channel.setAgentForwarding(client._forwardAgent);
          channel.setCommand(command);
          InputStream input = channel.getInputStream();
          output = new DataOutputStream(channel.getOutputStream());
          synchronized (client) {
            client._herdrCommandChannel = channel;
            client._herdrCommandOutputStream = output;
          }
          channel.connect(SSH_CHANNEL_CONNECT_TIMEOUT_MS);
          started = true;
          callback.invoke();

          InputStreamReader reader = new InputStreamReader(input, StandardCharsets.UTF_8);
          char[] chars = new char[8192];
          int count;
          while (clientPool.get(key) == client && channel.isConnected() && (count = reader.read(chars)) >= 0) {
            if (count > 0) sendHerdrCommandStreamEvent(key, new String(chars, 0, count), false, null);
          }
          sendHerdrCommandStreamEvent(key, null, true, null);
        } catch (Exception error) {
          Log.e(LOGTAG, "Herdr command stream failed: " + error.getMessage());
          if (!started) callback.invoke(error.getMessage());
          else sendHerdrCommandStreamEvent(key, null, true, error.getMessage());
        } finally {
          SSHClient client = clientPool.get(key);
          closeHerdrCommandStreamConnection(client, channel, output);
        }
      }
    }).start();
  }

  @ReactMethod
  public void writeHerdrCommandStream(final String value, final String key, final Callback callback) {
    try {
      SSHClient client = clientPool.get(key);
      if (client == null) throw new IOException("client is null");
      synchronized (client) {
        if (client._herdrCommandOutputStream == null) throw new IOException("Herdr command stream is not active");
        client._herdrCommandOutputStream.write(value.getBytes(StandardCharsets.UTF_8));
        client._herdrCommandOutputStream.flush();
      }
      callback.invoke();
    } catch (Exception error) {
      callback.invoke(error.getMessage());
    }
  }

  @ReactMethod
  public void closeHerdrCommandStream(final String key) {
    SSHClient client = clientPool.get(key);
    if (client != null) closeHerdrCommandStreamClient(client);
  }

  private void sendHerdrCommandStreamEvent(
      String key,
      @Nullable String data,
      boolean closed,
      @Nullable String error
  ) {
    WritableMap value = Arguments.createMap();
    if (data != null) value.putString("data", data);
    value.putBoolean("closed", closed);
    if (error != null) value.putString("error", error);

    WritableMap event = Arguments.createMap();
    event.putString("name", "HerdrCommandStream");
    event.putString("key", key);
    event.putMap("value", value);
    sendEvent(reactContext, "HerdrCommandStream", event);
  }

  private void closeHerdrCommandStreamClient(SSHClient client) {
    ChannelExec channel;
    DataOutputStream output;
    synchronized (client) {
      channel = client._herdrCommandChannel;
      output = client._herdrCommandOutputStream;
      client._herdrCommandChannel = null;
      client._herdrCommandOutputStream = null;
    }
    closeHerdrCommandStreamConnection(null, channel, output);
  }

  private void closeHerdrCommandStreamConnection(
      @Nullable SSHClient client,
      @Nullable ChannelExec channel,
      @Nullable DataOutputStream output
  ) {
    if (client != null) {
      synchronized (client) {
        // A replacement stream may already own the client fields. The reader
        // finishing for an older channel must never close that replacement.
        if (client._herdrCommandChannel == channel) {
          client._herdrCommandChannel = null;
          client._herdrCommandOutputStream = null;
        }
      }
    }
    try {
      if (output != null) {
        output.flush();
        output.close();
      }
    } catch (IOException error) {
      Log.e(LOGTAG, "Error closing Herdr command output: " + error.getMessage());
    }
    if (channel != null) {
      channel.disconnect();
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
  public void openLocalForward(final String remoteHost, final Integer remotePort, final String key, final Callback callback) {
    new Thread(new Runnable() {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client == null || client._session == null || !client._session.isConnected()) {
            callback.invoke("SSH connection is not active");
            return;
          }
          int localPort = client._session.setPortForwardingL("127.0.0.1", 0, remoteHost, remotePort);
          callback.invoke(null, localPort);
        } catch (Exception error) {
          Log.e(LOGTAG, "Failed to open local forward: " + error.getMessage());
          callback.invoke(error.getMessage());
        }
      }
    }).start();
  }

  @ReactMethod
  public void closeLocalForward(final Integer localPort, final String key, final Callback callback) {
    new Thread(new Runnable() {
      public void run() {
        try {
          SSHClient client = clientPool.get(key);
          if (client != null && client._session != null && client._session.isConnected()) {
            client._session.delPortForwardingL("127.0.0.1", localPort);
          }
          callback.invoke();
        } catch (Exception error) {
          Log.e(LOGTAG, "Failed to close local forward: " + error.getMessage());
          callback.invoke(error.getMessage());
        }
      }
    }).start();
  }

  @ReactMethod
  public void disconnect(final String key) {
    SSHClient client = clientPool.remove(key);
    if (client != null) {
        closeShellClient(client);
      closeHerdrBridgeClient(client);
      closeHerdrEventStreamClient(client);
      closeHerdrCommandStreamClient(client);
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
