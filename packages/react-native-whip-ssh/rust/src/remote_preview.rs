use std::sync::Arc;

use url::Url;

use crate::host_runtime::HostRuntimeError;
use crate::remote_ops::{
    HtmlServerProcess, ManagedPreview, PreviewInfo, PreviewKind, PreviewResource, PreviewState,
    remote_filename, remote_parent, shell_quote,
};
use crate::ssh::SshSession;

const PYTHON_HTTP_SERVER: &str = r#"import http.server
import os
import sys
import threading
os.chdir(sys.argv[1])
server_class = getattr(http.server, "ThreadingHTTPServer", http.server.HTTPServer)
server = server_class(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
timer = threading.Timer(3600, server.shutdown)
timer.daemon = True
timer.start()
print(server.server_port, flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()"#;

const NODE_HTTP_SERVER: &str = r#"const fs=require("fs"),http=require("http"),path=require("path");
const root=path.resolve(process.argv[1]);
const types={".css":"text/css; charset=utf-8",".gif":"image/gif",".htm":"text/html; charset=utf-8",".html":"text/html; charset=utf-8",".ico":"image/x-icon",".jpeg":"image/jpeg",".jpg":"image/jpeg",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".png":"image/png",".svg":"image/svg+xml",".wasm":"application/wasm",".webp":"image/webp"};
const reply=(r,s,b)=>{r.writeHead(s,{"Content-Type":"text/plain; charset=utf-8"});r.end(b)};
const server=http.createServer((q,r)=>{let n;try{n=decodeURIComponent(new URL(q.url||"/","http://127.0.0.1").pathname)}catch{reply(r,400,"Bad request");return}let f=path.resolve(root,"."+n);if(f!==root&&!f.startsWith(root+path.sep)){reply(r,403,"Forbidden");return}const send=c=>fs.readFile(c,(e,d)=>{if(e){reply(r,e.code==="ENOENT"?404:500,e.code==="ENOENT"?"Not found":"Preview error");return}r.writeHead(200,{"Content-Type":types[path.extname(c).toLowerCase()]||"application/octet-stream"});r.end(d)});fs.stat(f,(e,s)=>{if(e){reply(r,e.code==="ENOENT"?404:500,e.code==="ENOENT"?"Not found":"Preview error");return}if(s.isDirectory())f=path.join(f,"index.html");send(f)})});
server.listen(0,"127.0.0.1",()=>console.log(server.address().port));
setTimeout(()=>server.close(),3600000).unref()"#;

fn temporary_file(token: &str, extension: &str) -> String {
    format!("/tmp/whip-html-preview-{token}.{extension}")
}

fn encode_url_segment(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";

    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}

fn start_command(directory: &str, token: &str) -> String {
    let port_file = temporary_file(token, "port");
    let log_file = temporary_file(token, "log");
    let script = format!(
        "rm -f {port} {log}\nif command -v python3 >/dev/null 2>&1; then\n  nohup python3 -c {python} {directory} >{port} 2>{log} </dev/null &\nelif command -v node >/dev/null 2>&1; then\n  nohup node -e {node} {directory} >{port} 2>{log} </dev/null &\nelse\n  printf '__WHIP_HTML_PREVIEW_ERROR__:%s\\n' 'Neither python3 nor node is installed on the remote host'; exit 0\nfi\npreview_pid=$!\npreview_attempt=0\nwhile [ \"$preview_attempt\" -lt 50 ]; do\n  if [ -s {port} ]; then IFS= read -r preview_port < {port}; printf '%s:%s\\n' \"$preview_pid\" \"$preview_port\"; exit 0; fi\n  if ! kill -0 \"$preview_pid\" 2>/dev/null; then printf '__WHIP_HTML_PREVIEW_ERROR__:%s\\n' 'The preview server process failed to start'; sed -n '1,3p' {log}; exit 0; fi\n  preview_attempt=$((preview_attempt + 1)); sleep 0.1\ndone\nkill \"$preview_pid\" 2>/dev/null || true\nprintf '__WHIP_HTML_PREVIEW_ERROR__:%s\\n' 'Timed out starting the remote preview server'",
        port = shell_quote(&port_file),
        log = shell_quote(&log_file),
        python = shell_quote(PYTHON_HTTP_SERVER),
        node = shell_quote(NODE_HTTP_SERVER),
        directory = shell_quote(directory),
    );
    format!("sh -c {}", shell_quote(&script))
}

fn parse_process(output: &[u8], token: &str) -> Result<HtmlServerProcess, HostRuntimeError> {
    let output = std::str::from_utf8(output).map_err(|_| {
        HostRuntimeError::PreviewFailure("HTML preview startup output was not UTF-8".to_owned())
    })?;
    if let Some(error) = output
        .lines()
        .find_map(|line| line.strip_prefix("__WHIP_HTML_PREVIEW_ERROR__:"))
    {
        return Err(HostRuntimeError::PreviewFailure(error.to_owned()));
    }
    let (pid, port) = output
        .lines()
        .find_map(|line| {
            let (pid, port) = line.split_once(':')?;
            Some((pid.parse::<u32>().ok()?, port.parse::<u16>().ok()?))
        })
        .ok_or_else(|| {
            HostRuntimeError::PreviewFailure(if output.trim().is_empty() {
                "The remote preview server returned no address".to_owned()
            } else {
                output.trim().to_owned()
            })
        })?;
    Ok(HtmlServerProcess {
        pid,
        port,
        port_file: temporary_file(token, "port"),
        log_file: temporary_file(token, "log"),
    })
}

fn stop_command(process: &HtmlServerProcess) -> String {
    let script = format!(
        "kill {} 2>/dev/null || true\nrm -f {} {}",
        process.pid,
        shell_quote(&process.port_file),
        shell_quote(&process.log_file),
    );
    format!("sh -c {}", shell_quote(&script))
}

pub(crate) async fn start_web_preview(
    ssh: Arc<SshSession>,
    id: String,
    generation: u64,
    remote_url: &str,
) -> Result<(PreviewInfo, ManagedPreview), HostRuntimeError> {
    let mut url = Url::parse(remote_url).map_err(|error| {
        HostRuntimeError::PreviewFailure(format!("invalid preview URL: {error}"))
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(HostRuntimeError::PreviewFailure(
            "only HTTP and HTTPS previews can be forwarded".to_owned(),
        ));
    }
    let remote_host = url
        .host_str()
        .ok_or_else(|| HostRuntimeError::PreviewFailure("preview URL has no host".to_owned()))?
        .to_owned();
    let remote_port = url.port_or_known_default().ok_or_else(|| {
        HostRuntimeError::PreviewFailure("preview URL has no usable port".to_owned())
    })?;
    let local_port = ssh.open_local_forward(&remote_host, remote_port).await?;
    if url.set_host(Some("127.0.0.1")).is_err() || url.set_port(Some(local_port)).is_err() {
        ssh.close_local_forward(local_port);
        return Err(HostRuntimeError::PreviewFailure(
            "could not build local preview URL".to_owned(),
        ));
    }
    Ok((
        PreviewInfo {
            preview_id: id,
            kind: PreviewKind::WebForward,
            state: PreviewState::Running,
            local_url: url.to_string(),
            display_url: Some(remote_url.to_owned()),
        },
        ManagedPreview {
            generation,
            resource: PreviewResource::Forward { local_port },
        },
    ))
}

pub(crate) async fn start_html_preview(
    ssh: Arc<SshSession>,
    id: String,
    generation: u64,
    remote_path: &str,
) -> Result<(PreviewInfo, ManagedPreview), HostRuntimeError> {
    let directory = remote_parent(remote_path).map_err(HostRuntimeError::PreviewFailure)?;
    let filename = remote_filename(remote_path).map_err(HostRuntimeError::PreviewFailure)?;
    let output = ssh.execute(&start_command(&directory, &id)).await?;
    let process = parse_process(&output.stdout, &id)?;
    let local_port = match ssh.open_local_forward("127.0.0.1", process.port).await {
        Ok(port) => port,
        Err(error) => {
            let _ = ssh.execute(&stop_command(&process)).await;
            return Err(error.into());
        }
    };
    let encoded = encode_url_segment(&filename);
    Ok((
        PreviewInfo {
            preview_id: id,
            kind: PreviewKind::Html,
            state: PreviewState::Running,
            local_url: format!("http://127.0.0.1:{local_port}/{encoded}"),
            display_url: Some(format!("http://127.0.0.1:{}/{encoded}", process.port)),
        },
        ManagedPreview {
            generation,
            resource: PreviewResource::Html {
                local_port,
                process,
            },
        },
    ))
}

pub(crate) async fn start_remote_file_preview(
    ssh: Arc<SshSession>,
    id: String,
    generation: u64,
    remote_path: &str,
) -> Result<(PreviewInfo, ManagedPreview), HostRuntimeError> {
    let filename = remote_filename(remote_path).map_err(HostRuntimeError::PreviewFailure)?;
    let server = ssh.start_sftp_file_server(remote_path).await?;
    let encoded = encode_url_segment(&filename);
    Ok((
        PreviewInfo {
            preview_id: id,
            kind: PreviewKind::RemoteFile,
            state: PreviewState::Running,
            local_url: format!(
                "http://127.0.0.1:{}/{}/{encoded}",
                server.local_port, server.token
            ),
            display_url: None,
        },
        ManagedPreview {
            generation,
            resource: PreviewResource::RemoteFile {
                local_port: server.local_port,
            },
        },
    ))
}

pub(crate) async fn stop_preview(ssh: &SshSession, resource: PreviewResource) {
    match resource {
        PreviewResource::Forward { local_port } => ssh.close_local_forward(local_port),
        PreviewResource::RemoteFile { local_port } => ssh.close_sftp_file_server(local_port),
        PreviewResource::Html {
            local_port,
            process,
        } => {
            ssh.close_local_forward(local_port);
            let _ = ssh.execute(&stop_command(&process)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_url_segments_preserve_unreserved_ascii() {
        assert_eq!(
            encode_url_segment("report-1_final~.html"),
            "report-1_final~.html"
        );
    }

    #[test]
    fn preview_url_segments_encode_reserved_ascii() {
        assert_eq!(encode_url_segment("space here"), "space%20here");
        assert_eq!(
            encode_url_segment("report #1; $final.html"),
            "report%20%231%3B%20%24final.html"
        );
        assert_eq!(encode_url_segment("100%/done"), "100%25%2Fdone");
    }

    #[test]
    fn preview_url_segments_encode_unicode_as_utf8_bytes() {
        assert_eq!(encode_url_segment("資料.html"), "%E8%B3%87%E6%96%99.html");
    }
}
