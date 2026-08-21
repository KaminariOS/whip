const MIN_PROTOCOL: u32 = 17;
const MAX_PROTOCOL: u32 = 20;
pub const MAX_FRAME_SIZE: usize = 32 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub struct Message {
    pub kind: &'static str,
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub flag: bool,
    pub bytes: Vec<u8>,
    pub text: Option<String>,
    pub body: Option<String>,
    pub count: u32,
}

impl Message {
    fn new(kind: &'static str) -> Self {
        Self {
            kind,
            sequence: 0,
            width: 0,
            height: 0,
            flag: false,
            bytes: Vec::new(),
            text: None,
            body: None,
            count: 0,
        }
    }
}

pub fn hello(
    protocol: u32,
    columns: u32,
    rows: u32,
    cell_width: u32,
    cell_height: u32,
) -> Result<Vec<u8>, String> {
    check_protocol(protocol)?;
    let mut encoder = Encoder::default();
    encoder.unsigned(0); // ClientMessage::Hello
    encoder.unsigned(protocol as u64);
    encoder.unsigned(columns as u64);
    encoder.unsigned(rows as u64);
    encoder.unsigned(cell_width as u64);
    encoder.unsigned(cell_height as u64);
    encoder.unsigned(1); // RenderEncoding::TerminalAnsi
    encoder.unsigned(0); // ClientKeybindings::Server
    encoder.unsigned(1); // ClientLaunchMode::TerminalAttach
    Ok(frame(encoder.finish()))
}

pub fn input(text: &str) -> Vec<u8> {
    let mut encoder = Encoder::default();
    encoder.unsigned(1);
    encoder.bytes(text.as_bytes());
    frame(encoder.finish())
}

pub fn resize(columns: u32, rows: u32, cell_width: u32, cell_height: u32) -> Vec<u8> {
    let mut encoder = Encoder::default();
    encoder.unsigned(3);
    encoder.unsigned(columns as u64);
    encoder.unsigned(rows as u64);
    encoder.unsigned(cell_width as u64);
    encoder.unsigned(cell_height as u64);
    frame(encoder.finish())
}

pub fn detach() -> Vec<u8> {
    frame(vec![4])
}

pub fn attach(terminal_id: &str, takeover: bool) -> Vec<u8> {
    let mut encoder = Encoder::default();
    encoder.unsigned(5);
    encoder.bytes(terminal_id.as_bytes());
    encoder.boolean(takeover);
    frame(encoder.finish())
}

pub fn scroll(up: bool, lines: u32) -> Vec<u8> {
    let mut encoder = Encoder::default();
    encoder.unsigned(6);
    encoder.unsigned(0); // wheel
    encoder.unsigned(if up { 0 } else { 1 });
    encoder.unsigned(lines as u64);
    encoder.byte(0); // no column
    encoder.byte(0); // no row
    encoder.byte(0); // modifiers
    frame(encoder.finish())
}

pub fn decode(payload: &[u8], protocol: u32) -> Result<Message, String> {
    check_protocol(protocol)?;
    let mut decoder = Decoder::new(payload);
    let variant = decoder.unsigned()?;
    let mut message = match variant {
        0 => Message::new("welcome"),
        2 => Message::new("terminal"),
        3 => Message::new("graphics"),
        4 => Message::new("closed"),
        5 => Message::new("notify"),
        6 => Message::new("clipboard"),
        7 => Message::new("title"),
        8 => Message::new("reload_sound_config"),
        9 => Message::new("mouse_capture"),
        10 if protocol == 17 => Message::new("prefix_input_source"),
        10 => Message::new("kitty_keyboard_report_all"),
        11 if protocol >= 18 => Message::new("prefix_input_source"),
        12 if protocol >= 20 => Message::new("terminal_bell"),
        _ => Message::new("ignored"),
    };
    match message.kind {
        "welcome" => {
            message.sequence = decoder.unsigned()?;
            message.width = decoder.u32()?;
            message.text = decoder.option_string()?;
        }
        "terminal" => {
            message.sequence = decoder.unsigned()?;
            message.width = decoder.u32()?;
            message.height = decoder.u32()?;
            message.flag = decoder.boolean()?;
            message.bytes = decoder.bytes()?.to_vec();
        }
        "graphics" => message.bytes = decoder.bytes()?.to_vec(),
        "closed" | "title" => message.text = decoder.option_string()?,
        "notify" => {
            message.width = decoder.u32()?;
            message.text = Some(decoder.string()?);
            message.body = decoder.option_string()?;
        }
        "clipboard" => message.text = Some(decoder.string()?),
        "mouse_capture" | "kitty_keyboard_report_all" | "prefix_input_source" => {
            message.flag = decoder.boolean()?;
        }
        "terminal_bell" => {
            message.count = u32::try_from(decoder.unsigned()?)
                .map_err(|_| "invalid Herdr terminal bell count".to_owned())?;
            if message.count > 0xffff {
                return Err(format!(
                    "invalid Herdr terminal bell count {}",
                    message.count
                ));
            }
        }
        _ => {}
    }
    Ok(message)
}

fn check_protocol(protocol: u32) -> Result<(), String> {
    if (MIN_PROTOCOL..=MAX_PROTOCOL).contains(&protocol) {
        Ok(())
    } else {
        Err(format!(
            "Herdr protocol mismatch: iOS bridge supports {MIN_PROTOCOL} through {MAX_PROTOCOL}, server reports {protocol}"
        ))
    }
}

fn frame(payload: Vec<u8>) -> Vec<u8> {
    let mut result = Vec::with_capacity(payload.len() + 4);
    result.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    result.extend_from_slice(&payload);
    result
}

#[derive(Default)]
struct Encoder(Vec<u8>);

impl Encoder {
    fn unsigned(&mut self, value: u64) {
        match value {
            0..=250 => self.0.push(value as u8),
            251..=0xffff => {
                self.0.push(251);
                self.0.extend_from_slice(&(value as u16).to_le_bytes());
            }
            0x1_0000..=0xffff_ffff => {
                self.0.push(252);
                self.0.extend_from_slice(&(value as u32).to_le_bytes());
            }
            _ => {
                self.0.push(253);
                self.0.extend_from_slice(&value.to_le_bytes());
            }
        }
    }

    fn bytes(&mut self, value: &[u8]) {
        self.unsigned(value.len() as u64);
        self.0.extend_from_slice(value);
    }

    fn boolean(&mut self, value: bool) {
        self.byte(u8::from(value));
    }

    fn byte(&mut self, value: u8) {
        self.0.push(value);
    }

    fn finish(self) -> Vec<u8> {
        self.0
    }
}

struct Decoder<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> Decoder<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, offset: 0 }
    }

    fn byte(&mut self) -> Result<u8, String> {
        let value = self
            .input
            .get(self.offset)
            .copied()
            .ok_or_else(|| "unexpected end of bincode payload".to_owned())?;
        self.offset += 1;
        Ok(value)
    }

    fn unsigned(&mut self) -> Result<u64, String> {
        match self.byte()? {
            marker @ 0..=250 => Ok(marker as u64),
            251 => Ok(u16::from_le_bytes(self.array()?) as u64),
            252 => Ok(u32::from_le_bytes(self.array()?) as u64),
            253 => Ok(u64::from_le_bytes(self.array()?)),
            marker => Err(format!("unsupported bincode integer marker {marker}")),
        }
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let end = self.offset.saturating_add(N);
        let bytes = self
            .input
            .get(self.offset..end)
            .ok_or_else(|| "unexpected end of bincode integer".to_owned())?;
        self.offset = end;
        bytes
            .try_into()
            .map_err(|_| "invalid bincode integer".to_owned())
    }

    fn u32(&mut self) -> Result<u32, String> {
        u32::try_from(self.unsigned()?).map_err(|_| "bincode value exceeds u32".to_owned())
    }

    fn boolean(&mut self) -> Result<bool, String> {
        match self.byte()? {
            0 => Ok(false),
            1 => Ok(true),
            value => Err(format!("invalid bincode bool {value}")),
        }
    }

    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let length = usize::try_from(self.unsigned()?)
            .map_err(|_| "invalid bincode byte length".to_owned())?;
        let end = self.offset.saturating_add(length);
        let value = self
            .input
            .get(self.offset..end)
            .ok_or_else(|| format!("invalid bincode byte length {length}"))?;
        self.offset = end;
        Ok(value)
    }

    fn string(&mut self) -> Result<String, String> {
        String::from_utf8(self.bytes()?.to_vec()).map_err(|error| error.to_string())
    }

    fn option_string(&mut self) -> Result<Option<String>, String> {
        match self.byte()? {
            0 => Ok(None),
            1 => self.string().map(Some),
            value => Err(format!("invalid bincode option tag {value}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_matches_android_wire_format() {
        assert_eq!(
            hello(20, 80, 24, 8, 16).unwrap(),
            vec![9, 0, 0, 0, 0, 20, 80, 24, 8, 16, 1, 0, 1]
        );
    }

    #[test]
    fn input_and_attach_are_framed() {
        assert_eq!(input("hi"), vec![4, 0, 0, 0, 1, 2, b'h', b'i']);
        assert_eq!(attach("t1", true), vec![5, 0, 0, 0, 5, 2, b't', b'1', 1]);
    }

    #[test]
    fn decodes_terminal_message() {
        let payload = [2, 42, 80, 24, 1, 3, b'a', b'b', b'c'];
        let message = decode(&payload, 20).unwrap();
        assert_eq!(message.kind, "terminal");
        assert_eq!(message.sequence, 42);
        assert_eq!(message.bytes, b"abc");
        assert!(message.flag);
    }
}
