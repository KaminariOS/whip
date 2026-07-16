package me.dylankenneally.rnssh;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

final class HerdrBridgeCodec {
  static final int MAX_FRAME_SIZE = 32 * 1024 * 1024;

  static final class Message {
    final String type;
    long sequence;
    int width;
    int height;
    boolean flag;
    byte[] bytes;
    String text;
    String body;

    Message(String type) {
      this.type = type;
    }
  }

  private HerdrBridgeCodec() {}

  static byte[] hello(
      int protocol,
      int columns,
      int rows,
      int cellWidthPx,
      int cellHeightPx
  ) throws IOException {
    Encoder encoder = new Encoder();
    encoder.variant(0); // ClientMessage::Hello
    encoder.unsigned(protocol);
    encoder.unsigned(columns);
    encoder.unsigned(rows);
    encoder.unsigned(cellWidthPx);
    encoder.unsigned(cellHeightPx);
    encoder.variant(1); // RenderEncoding::TerminalAnsi
    encoder.variant(0); // ClientKeybindings::Server
    encoder.variant(1); // ClientLaunchMode::TerminalAttach
    return frame(encoder.finish());
  }

  static byte[] input(String text) throws IOException {
    Encoder encoder = new Encoder();
    encoder.variant(1); // ClientMessage::Input
    encoder.bytes(text.getBytes(StandardCharsets.UTF_8));
    return frame(encoder.finish());
  }

  static byte[] resize(int columns, int rows, int cellWidthPx, int cellHeightPx) throws IOException {
    Encoder encoder = new Encoder();
    encoder.variant(3); // ClientMessage::Resize
    encoder.unsigned(columns);
    encoder.unsigned(rows);
    encoder.unsigned(cellWidthPx);
    encoder.unsigned(cellHeightPx);
    return frame(encoder.finish());
  }

  static byte[] detach() throws IOException {
    Encoder encoder = new Encoder();
    encoder.variant(4); // ClientMessage::Detach
    return frame(encoder.finish());
  }

  static byte[] attachTerminal(String terminalId, boolean takeover) throws IOException {
    Encoder encoder = new Encoder();
    encoder.variant(5); // ClientMessage::AttachTerminal
    encoder.string(terminalId);
    encoder.bool(takeover);
    return frame(encoder.finish());
  }

  static byte[] scroll(boolean up, int lines) throws IOException {
    Encoder encoder = new Encoder();
    encoder.variant(6); // ClientMessage::AttachScroll
    encoder.variant(0); // AttachScrollSource::Wheel
    encoder.variant(up ? 0 : 1); // AttachScrollDirection
    encoder.unsigned(lines);
    encoder.optionNone(); // column
    encoder.optionNone(); // row
    encoder.byteValue(0); // modifiers
    return frame(encoder.finish());
  }

  static Message decode(byte[] payload) throws IOException {
    Decoder decoder = new Decoder(payload);
    long variant = decoder.unsigned();
    Message message;
    if (variant == 0) {
      message = new Message("welcome");
      message.sequence = decoder.unsigned(); // protocol version
      message.width = (int) decoder.unsigned(); // RenderEncoding
      message.text = decoder.optionString();
    } else if (variant == 2) {
      message = new Message("terminal");
      message.sequence = decoder.unsigned();
      message.width = (int) decoder.unsigned();
      message.height = (int) decoder.unsigned();
      message.flag = decoder.bool();
      message.bytes = decoder.bytes();
    } else if (variant == 3) {
      message = new Message("graphics");
      message.bytes = decoder.bytes();
    } else if (variant == 4) {
      message = new Message("closed");
      message.text = decoder.optionString();
    } else if (variant == 5) {
      message = new Message("notify");
      message.width = (int) decoder.unsigned(); // NotifyKind
      message.text = decoder.string();
      message.body = decoder.optionString();
    } else if (variant == 6) {
      message = new Message("clipboard");
      message.text = decoder.string();
    } else if (variant == 7) {
      message = new Message("title");
      message.text = decoder.optionString();
    } else if (variant == 8) {
      message = new Message("reload_sound_config");
    } else if (variant == 9) {
      message = new Message("mouse_capture");
      message.flag = decoder.bool();
    } else if (variant == 10) {
      message = new Message("prefix_input_source");
      message.flag = decoder.bool();
    } else {
      message = new Message("ignored");
    }
    return message;
  }

  private static byte[] frame(byte[] payload) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream(payload.length + 4);
    int length = payload.length;
    output.write(length & 0xff);
    output.write((length >>> 8) & 0xff);
    output.write((length >>> 16) & 0xff);
    output.write((length >>> 24) & 0xff);
    output.write(payload);
    return output.toByteArray();
  }

  private static final class Encoder {
    private final ByteArrayOutputStream output = new ByteArrayOutputStream();

    void variant(long value) throws IOException { unsigned(value); }

    void unsigned(long value) throws IOException {
      if (value < 0) throw new IOException("negative value for unsigned bincode integer");
      if (value <= 250) {
        output.write((int) value);
      } else if (value <= 0xffffL) {
        output.write(251);
        littleEndian(value, 2);
      } else if (value <= 0xffff_ffffL) {
        output.write(252);
        littleEndian(value, 4);
      } else {
        output.write(253);
        littleEndian(value, 8);
      }
    }

    void string(String value) throws IOException {
      bytes(value.getBytes(StandardCharsets.UTF_8));
    }

    void bytes(byte[] value) throws IOException {
      unsigned(value.length);
      output.write(value);
    }

    void bool(boolean value) {
      output.write(value ? 1 : 0);
    }

    void optionNone() {
      output.write(0);
    }

    void byteValue(int value) {
      output.write(value & 0xff);
    }

    byte[] finish() {
      return output.toByteArray();
    }

    private void littleEndian(long value, int bytes) {
      for (int index = 0; index < bytes; index += 1) {
        output.write((int) ((value >>> (index * 8)) & 0xff));
      }
    }
  }

  private static final class Decoder {
    private final byte[] input;
    private int offset;

    Decoder(byte[] input) {
      this.input = input;
    }

    long unsigned() throws IOException {
      int marker = byteValue();
      if (marker <= 250) return marker;
      if (marker == 251) return littleEndian(2);
      if (marker == 252) return littleEndian(4);
      if (marker == 253) return littleEndian(8);
      throw new IOException("unsupported bincode integer marker " + marker);
    }

    boolean bool() throws IOException {
      int value = byteValue();
      if (value == 0) return false;
      if (value == 1) return true;
      throw new IOException("invalid bincode bool " + value);
    }

    String optionString() throws IOException {
      int present = byteValue();
      if (present == 0) return null;
      if (present == 1) return string();
      throw new IOException("invalid bincode option tag " + present);
    }

    String string() throws IOException {
      return new String(bytes(), StandardCharsets.UTF_8);
    }

    byte[] bytes() throws IOException {
      long length = unsigned();
      if (length < 0 || length > Integer.MAX_VALUE || offset + length > input.length) {
        throw new IOException("invalid bincode byte length " + length);
      }
      byte[] value = new byte[(int) length];
      System.arraycopy(input, offset, value, 0, value.length);
      offset += value.length;
      return value;
    }

    private int byteValue() throws IOException {
      if (offset >= input.length) throw new IOException("unexpected end of bincode payload");
      return input[offset++] & 0xff;
    }

    private long littleEndian(int bytes) throws IOException {
      if (offset + bytes > input.length) throw new IOException("unexpected end of bincode integer");
      long value = 0;
      for (int index = 0; index < bytes; index += 1) {
        value |= ((long) input[offset++] & 0xffL) << (index * 8);
      }
      return value;
    }
  }
}
