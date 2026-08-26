//! Native composition with the product-neutral `react-native-russh` channel API.

use std::ffi::c_char;
#[cfg(any(target_os = "android", target_os = "ios"))]
use std::ffi::{CStr, CString};

pub type OpenedCallback = unsafe extern "C" fn(u64, *const c_char);
pub type FrameCallback = unsafe extern "C" fn(u64, *const u8, usize);
pub type ClosedCallback = unsafe extern "C" fn(u64, *const c_char);
pub type RequestCallback = unsafe extern "C" fn(u64, *const u8, usize, *const c_char);

#[cfg(any(target_os = "android", target_os = "ios"))]
type OpenFn = unsafe extern "C" fn(
    u64,
    *const c_char,
    *const c_char,
    *const c_char,
    usize,
    Option<OpenedCallback>,
    Option<FrameCallback>,
    Option<ClosedCallback>,
);
#[cfg(any(target_os = "android", target_os = "ios"))]
type WriteFn = unsafe extern "C" fn(*const c_char, *const c_char, *const u8, usize) -> *mut c_char;
#[cfg(any(target_os = "android", target_os = "ios"))]
type CloseFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
#[cfg(any(target_os = "android", target_os = "ios"))]
type FreeFn = unsafe extern "C" fn(*mut c_char);
#[cfg(any(target_os = "android", target_os = "ios"))]
type RequestFn = unsafe extern "C" fn(
    u64,
    *const c_char,
    *const c_char,
    *const u8,
    usize,
    u8,
    u64,
    usize,
    Option<RequestCallback>,
);

#[cfg(any(target_os = "android", target_os = "ios"))]
fn c_string(value: &str, name: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| format!("{name} contains a NUL byte"))
}

#[cfg(target_os = "android")]
mod platform {
    use std::sync::OnceLock;

    use libloading::Library;

    use super::{CloseFn, FreeFn, OpenFn, RequestFn, WriteFn};

    pub struct Api {
        _library: Library,
        pub request: RequestFn,
        pub open_raw: OpenFn,
        pub open_framed: OpenFn,
        pub write_raw: WriteFn,
        pub write_framed: WriteFn,
        pub close: CloseFn,
        pub free: FreeFn,
    }

    // Function pointers remain valid because `Api` owns the loaded library for
    // the process lifetime.
    unsafe impl Send for Api {}
    unsafe impl Sync for Api {}

    static API: OnceLock<Result<Api, String>> = OnceLock::new();

    pub fn api() -> Result<&'static Api, String> {
        API.get_or_init(|| unsafe {
            let library = Library::new("libreact-native-russh.so").map_err(|error| {
                format!("react-native-russh native transport is unavailable: {error}")
            })?;
            let request = *library
                .get::<RequestFn>(b"react_native_russh_request_native_unix_socket\0")
                .map_err(|error| error.to_string())?;
            let open_raw = *library
                .get::<OpenFn>(b"react_native_russh_open_native_unix_socket_channel\0")
                .map_err(|error| error.to_string())?;
            let open_framed = *library
                .get::<OpenFn>(
                    b"react_native_russh_open_native_length_prefixed_unix_socket_channel\0",
                )
                .map_err(|error| error.to_string())?;
            let write_raw = *library
                .get::<WriteFn>(b"react_native_russh_write_native_unix_socket_channel\0")
                .map_err(|error| error.to_string())?;
            let write_framed = *library
                .get::<WriteFn>(
                    b"react_native_russh_write_native_length_prefixed_unix_socket_channel\0",
                )
                .map_err(|error| error.to_string())?;
            let close = *library
                .get::<CloseFn>(b"react_native_russh_close_native_unix_socket_channel\0")
                .map_err(|error| error.to_string())?;
            let free = *library
                .get::<FreeFn>(b"react_native_russh_string_free\0")
                .map_err(|error| error.to_string())?;
            Ok(Api {
                _library: library,
                request,
                open_raw,
                open_framed,
                write_raw,
                write_framed,
                close,
                free,
            })
        })
        .as_ref()
        .map_err(Clone::clone)
    }
}

#[cfg(target_os = "ios")]
mod platform {
    use super::{CloseFn, FreeFn, OpenFn, RequestFn, WriteFn};

    unsafe extern "C" {
        fn react_native_russh_request_native_unix_socket(
            context: u64,
            key: *const std::ffi::c_char,
            socket_path: *const std::ffi::c_char,
            request: *const u8,
            request_length: usize,
            response_terminator: u8,
            timeout_ms: u64,
            max_response_bytes: usize,
            callback: Option<super::RequestCallback>,
        );
        fn react_native_russh_open_native_unix_socket_channel(
            context: u64,
            key: *const std::ffi::c_char,
            channel_id: *const std::ffi::c_char,
            socket_path: *const std::ffi::c_char,
            max_frame_bytes: usize,
            opened: Option<super::OpenedCallback>,
            frame: Option<super::FrameCallback>,
            closed: Option<super::ClosedCallback>,
        );
        fn react_native_russh_open_native_length_prefixed_unix_socket_channel(
            context: u64,
            key: *const std::ffi::c_char,
            channel_id: *const std::ffi::c_char,
            socket_path: *const std::ffi::c_char,
            max_frame_bytes: usize,
            opened: Option<super::OpenedCallback>,
            frame: Option<super::FrameCallback>,
            closed: Option<super::ClosedCallback>,
        );
        fn react_native_russh_write_native_length_prefixed_unix_socket_channel(
            key: *const std::ffi::c_char,
            channel_id: *const std::ffi::c_char,
            bytes: *const u8,
            length: usize,
        ) -> *mut std::ffi::c_char;
        fn react_native_russh_write_native_unix_socket_channel(
            key: *const std::ffi::c_char,
            channel_id: *const std::ffi::c_char,
            bytes: *const u8,
            length: usize,
        ) -> *mut std::ffi::c_char;
        fn react_native_russh_close_native_unix_socket_channel(
            key: *const std::ffi::c_char,
            channel_id: *const std::ffi::c_char,
        ) -> *mut std::ffi::c_char;
        fn react_native_russh_string_free(value: *mut std::ffi::c_char);
    }

    pub struct Api {
        pub request: RequestFn,
        pub open_raw: OpenFn,
        pub open_framed: OpenFn,
        pub write_raw: WriteFn,
        pub write_framed: WriteFn,
        pub close: CloseFn,
        pub free: FreeFn,
    }

    static API: Api = Api {
        request: react_native_russh_request_native_unix_socket,
        open_raw: react_native_russh_open_native_unix_socket_channel,
        open_framed: react_native_russh_open_native_length_prefixed_unix_socket_channel,
        write_raw: react_native_russh_write_native_unix_socket_channel,
        write_framed: react_native_russh_write_native_length_prefixed_unix_socket_channel,
        close: react_native_russh_close_native_unix_socket_channel,
        free: react_native_russh_string_free,
    };

    pub fn api() -> Result<&'static Api, String> {
        Ok(&API)
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod platform {
    pub fn unavailable() -> String {
        "native SSH channel composition is available only on Android and iOS".to_owned()
    }
}

#[allow(clippy::too_many_arguments)]
fn open_with(
    context: u64,
    key: &str,
    channel_id: &str,
    socket_path: &str,
    max_frame_bytes: usize,
    opened: OpenedCallback,
    frame: FrameCallback,
    closed: ClosedCallback,
    framed: bool,
) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let key = c_string(key, "SSH client key")?;
        let channel_id = c_string(channel_id, "channel id")?;
        let socket_path = c_string(socket_path, "socket path")?;
        let api = platform::api()?;
        let open = if framed {
            api.open_framed
        } else {
            api.open_raw
        };
        unsafe {
            open(
                context,
                key.as_ptr(),
                channel_id.as_ptr(),
                socket_path.as_ptr(),
                max_frame_bytes,
                Some(opened),
                Some(frame),
                Some(closed),
            );
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (
            context,
            key,
            channel_id,
            socket_path,
            max_frame_bytes,
            opened,
            frame,
            closed,
            framed,
        );
        Err(platform::unavailable())
    }
}

#[allow(clippy::too_many_arguments)]
pub fn open(
    context: u64,
    key: &str,
    channel_id: &str,
    socket_path: &str,
    max_frame_bytes: usize,
    opened: OpenedCallback,
    frame: FrameCallback,
    closed: ClosedCallback,
) -> Result<(), String> {
    open_with(
        context,
        key,
        channel_id,
        socket_path,
        max_frame_bytes,
        opened,
        frame,
        closed,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn open_raw(
    context: u64,
    key: &str,
    channel_id: &str,
    socket_path: &str,
    max_frame_bytes: usize,
    opened: OpenedCallback,
    frame: FrameCallback,
    closed: ClosedCallback,
) -> Result<(), String> {
    open_with(
        context,
        key,
        channel_id,
        socket_path,
        max_frame_bytes,
        opened,
        frame,
        closed,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn request(
    context: u64,
    key: &str,
    socket_path: &str,
    bytes: &[u8],
    response_terminator: u8,
    timeout_ms: u64,
    max_response_bytes: usize,
    callback: RequestCallback,
) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let key = c_string(key, "SSH client key")?;
        let socket_path = c_string(socket_path, "socket path")?;
        let api = platform::api()?;
        unsafe {
            (api.request)(
                context,
                key.as_ptr(),
                socket_path.as_ptr(),
                bytes.as_ptr(),
                bytes.len(),
                response_terminator,
                timeout_ms,
                max_response_bytes,
                Some(callback),
            );
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (
            context,
            key,
            socket_path,
            bytes,
            response_terminator,
            timeout_ms,
            max_response_bytes,
            callback,
        );
        Err(platform::unavailable())
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn take_result(api: &platform::Api, error: *mut c_char) -> Result<(), String> {
    if error.is_null() {
        return Ok(());
    }
    let message = unsafe { CStr::from_ptr(error) }
        .to_string_lossy()
        .into_owned();
    unsafe { (api.free)(error) };
    Err(message)
}

pub fn write(key: &str, channel_id: &str, bytes: &[u8]) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let key = c_string(key, "SSH client key")?;
        let channel_id = c_string(channel_id, "channel id")?;
        let api = platform::api()?;
        let error = unsafe {
            (api.write_framed)(
                key.as_ptr(),
                channel_id.as_ptr(),
                bytes.as_ptr(),
                bytes.len(),
            )
        };
        take_result(api, error)
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (key, channel_id, bytes);
        Err(platform::unavailable())
    }
}

pub fn write_raw(key: &str, channel_id: &str, bytes: &[u8]) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let key = c_string(key, "SSH client key")?;
        let channel_id = c_string(channel_id, "channel id")?;
        let api = platform::api()?;
        let error = unsafe {
            (api.write_raw)(
                key.as_ptr(),
                channel_id.as_ptr(),
                bytes.as_ptr(),
                bytes.len(),
            )
        };
        take_result(api, error)
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (key, channel_id, bytes);
        Err(platform::unavailable())
    }
}

pub fn close(key: &str, channel_id: &str) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let key = c_string(key, "SSH client key")?;
        let channel_id = c_string(channel_id, "channel id")?;
        let api = platform::api()?;
        let error = unsafe { (api.close)(key.as_ptr(), channel_id.as_ptr()) };
        take_result(api, error)
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (key, channel_id);
        Err(platform::unavailable())
    }
}
