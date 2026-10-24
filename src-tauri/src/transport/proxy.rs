//! The live-dictation WebSocket's proxy route.
//!
//! tungstenite dials the server directly and honours no proxy, so the route is decided here with
//! reqwest's own matcher (hyper-util's `Matcher`: the HTTP(S)_PROXY / ALL_PROXY / NO_PROXY env
//! vars, then the Windows / macOS proxy settings) — both halves of the transport go the same way —
//! and the socket tunnels with HTTP CONNECT.
//! A loopback server is always dialled directly by both halves, as WinINet and CFNetwork do,
//! because hyper-util's system matcher has no such bypass and a proxy cannot reach our loopback;
//! so are the OS bypass entries that matcher drops ([`BypassRules`]).

use hyper_util::client::proxy::matcher::Matcher;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::handshake::client::{Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, Uri};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

/// An HTTP proxy the stream URL tunnels through. `uri` never carries the login: hyper-util moves
/// the userinfo into `auth` when it parses the proxy URL, so `display` is credential-free.
pub(super) struct Proxy {
    uri: Uri,
    auth: Option<HeaderValue>,
    /// The `host:port` to CONNECT to, as an http(s) URI (the tunnel reads host and port from it).
    target: Uri,
}

impl Proxy {
    /// The proxy as it is safe to print: scheme + authority, bounded like `display_url`.
    pub(super) fn display(&self) -> String {
        let authority = self.uri.authority().map_or("", |a| a.as_str());
        super::bounded_server_text(&format!("http://{authority}"), 80)
    }
}

/// A URI host without its IPv6-literal brackets (`[::1]` → `::1`); anything else as given.
fn unbracketed(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
}

/// A this-host address: `localhost` / `*.localhost`, 127.0.0.0/8, `::1`, the unspecified `::` and
/// 0.0.0.0/8 (the bind-all address uvicorn prints, which `isLocalAddress` in backends.ts also counts
/// as this host), and an IPv4-mapped `::ffff:` form of any of those (bracketed or not). Both the
/// HTTP client and the WebSocket send these direct whatever the proxy settings say: through a proxy
/// they would dial the proxy's own host.
pub(super) fn is_loopback_host(host: &str) -> bool {
    use std::net::IpAddr;
    let host = unbracketed(host);
    if let Ok(ip) = host.parse::<IpAddr>() {
        let ip = match ip {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
            v4 => v4,
        };
        return match ip {
            IpAddr::V4(v4) => v4.is_loopback() || v4.octets()[0] == 0,
            IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
        };
    }
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    host == "localhost" || host.ends_with(".localhost")
}

/// The OS bypass entries hyper-util's system matcher leaves out, applied by both halves right after
/// the loopback bypass. hyper-util already turns the Windows ProxyOverride into its NO_PROXY list
/// (`;` → `,`, `*.corp` → `corp`, `10.*` → `10.0.0.0/8`) but keeps `<local>` there as a literal
/// domain no host can match, and on macOS it reads only the HTTP / HTTPS proxy, never the
/// ExceptionsList or ExcludeSimpleHostnames. Without these rules a dotless intranet server
/// (`http://gpu-server:8000`) or a listed exception goes to the proxy, which typically cannot
/// resolve it.
///
/// Read only when hyper-util reads the OS list itself: an OS proxy switched on, and NO_PROXY /
/// no_proxy unset or empty (a set one replaces the OS list in hyper-util, so it does here too).
/// hyper-util applies the Windows list even when HTTP(S)_PROXY supplied the proxy; these rules do
/// the same, so `<local>` and `*.corp` in one ProxyOverride never behave differently.
#[derive(Default)]
pub(super) struct BypassRules {
    /// Bypass hosts with no dot in the name, never an IP literal: Windows `<local>` (WinINet's
    /// meaning), macOS ExcludeSimpleHostnames.
    simple_hostnames: bool,
    /// macOS ExceptionsList: host globs (`*.local`, `*corp*`, `gpu.example`; a leading `.` reads as
    /// `*.`) and address ranges (`169.254/16` with the missing octets zero, `10.0.0.0/8`, a bare IP).
    exceptions: Vec<String>,
}

impl BypassRules {
    /// The OS rules in effect right now; none off Windows and macOS. Read per decision, as the
    /// matcher is (see [`system_client_proxy`]).
    pub(super) fn system() -> Self {
        #[cfg(any(windows, target_os = "macos"))]
        {
            let no_proxy = ["NO_PROXY", "no_proxy"]
                .iter()
                .find_map(|name| std::env::var(name).ok())
                .unwrap_or_default();
            if no_proxy.is_empty() {
                return os_bypass();
            }
        }
        Self::default()
    }

    /// The `<local>` entry of a ProxyOverride (`;`-separated); the rest is hyper-util's.
    #[cfg(any(windows, test))]
    fn from_windows_override(value: &str) -> Self {
        Self {
            simple_hostnames: value
                .split(';')
                .any(|entry| entry.trim().eq_ignore_ascii_case("<local>")),
            exceptions: Vec::new(),
        }
    }
}

/// Whether `host` goes direct under `rules` (see [`BypassRules`]).
fn bypass(host: &str, rules: &BypassRules) -> bool {
    use std::net::IpAddr;
    let host = unbracketed(host).to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    let ip = host.parse::<IpAddr>().ok();
    if rules.simple_hostnames && ip.is_none() && !host.is_empty() && !host.contains('.') {
        return true;
    }
    rules.exceptions.iter().any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        match (ip, address_range(&entry)) {
            (Some(ip), Some((net, len))) => in_range(ip, net, len),
            (None, Some(_)) => false,
            _ => match entry.strip_prefix('.') {
                Some(domain) => glob(format!("*.{domain}").as_bytes(), host.as_bytes()),
                None => glob(entry.as_bytes(), host.as_bytes()),
            },
        }
    })
}

/// An exception that names addresses: a bare IP, a CIDR, or macOS's short `169.254/16`.
fn address_range(entry: &str) -> Option<(std::net::IpAddr, u32)> {
    use std::net::IpAddr;
    let (addr, len) = match entry.split_once('/') {
        Some((addr, len)) => (addr, Some(len.parse::<u32>().ok()?)),
        None => (entry, None),
    };
    let ip = match addr.parse::<IpAddr>() {
        Ok(ip) => ip,
        Err(_) if len.is_some() => {
            let parts = addr
                .split('.')
                .map(|p| p.parse::<u8>().ok())
                .collect::<Option<Vec<_>>>()?;
            if parts.len() > 4 {
                return None;
            }
            let mut octets = [0u8; 4];
            octets[..parts.len()].copy_from_slice(&parts);
            IpAddr::from(octets)
        }
        Err(_) => return None,
    };
    let max = if ip.is_ipv4() { 32 } else { 128 };
    let len = len.unwrap_or(max);
    (len <= max).then_some((ip, len))
}

fn in_range(ip: std::net::IpAddr, net: std::net::IpAddr, len: u32) -> bool {
    use std::net::IpAddr;
    match (ip, net) {
        (IpAddr::V4(ip), IpAddr::V4(net)) => {
            let mask = u32::MAX.checked_shl(32 - len).unwrap_or(0);
            u32::from(ip) & mask == u32::from(net) & mask
        }
        (IpAddr::V6(ip), IpAddr::V6(net)) => {
            let mask = u128::MAX.checked_shl(128 - len).unwrap_or(0);
            u128::from(ip) & mask == u128::from(net) & mask
        }
        _ => false,
    }
}

/// `*` matches any run of characters (none included); everything else matches itself.
fn glob(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            star = Some((p, t));
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some((sp, st)) = star {
            // Let the last `*` swallow one more character and retry from there.
            star = Some((sp, st + 1));
            p = sp + 1;
            t = st + 1;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&c| c == b'*')
}

/// ProxyEnable + ProxyOverride from the key hyper-util reads them from; any read failure is "no
/// rules", as it is there.
#[cfg(windows)]
fn os_bypass() -> BypassRules {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings");
    let read = |name: &str, flags: u32, data: *mut core::ffi::c_void, len: &mut u32| {
        let name = wide(name);
        // SAFETY: both names are NUL-terminated and outlive the call; `data` is null (size query)
        // or points at `*len` writable bytes, which is what RegGetValueW requires.
        unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                std::ptr::null_mut(),
                data,
                len,
            )
        }
    };
    let mut enabled = 0u32;
    let mut len = 4u32;
    if read(
        "ProxyEnable",
        RRF_RT_REG_DWORD,
        (&mut enabled as *mut u32).cast(),
        &mut len,
    ) != 0
        || enabled == 0
    {
        return BypassRules::default();
    }
    let mut len = 0u32;
    if read(
        "ProxyOverride",
        RRF_RT_REG_SZ,
        std::ptr::null_mut(),
        &mut len,
    ) != 0
    {
        return BypassRules::default();
    }
    let mut buf = vec![0u16; (len as usize).div_ceil(2)];
    if read(
        "ProxyOverride",
        RRF_RT_REG_SZ,
        buf.as_mut_ptr().cast(),
        &mut len,
    ) != 0
    {
        return BypassRules::default();
    }
    buf.truncate(len as usize / 2);
    let value = String::from_utf16_lossy(&buf);
    BypassRules::from_windows_override(value.trim_end_matches('\0'))
}

/// ExcludeSimpleHostnames + ExceptionsList from the same SCDynamicStore proxies dictionary
/// hyper-util reads, when its HTTP or HTTPS proxy is switched on.
#[cfg(target_os = "macos")]
fn os_bypass() -> BypassRules {
    use system_configuration::core_foundation::array::CFArray;
    use system_configuration::core_foundation::base::{CFType, TCFType};
    use system_configuration::core_foundation::number::CFNumber;
    use system_configuration::core_foundation::string::CFString;
    use system_configuration::dynamic_store::SCDynamicStoreBuilder;
    use system_configuration::sys::schema_definitions::{
        kSCPropNetProxiesExceptionsList, kSCPropNetProxiesExcludeSimpleHostnames,
        kSCPropNetProxiesHTTPEnable, kSCPropNetProxiesHTTPSEnable,
    };
    let Some(proxies) = SCDynamicStoreBuilder::new("faster-whisper-frontend")
        .build()
        .and_then(|store| store.get_proxies())
    else {
        return BypassRules::default();
    };
    // SAFETY (each `unsafe` below): reading an immutable CFStringRef constant SystemConfiguration
    // exports, as hyper-util does.
    let flag = |key| {
        proxies
            .find(key)
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i32())
            == Some(1)
    };
    if !flag(unsafe { kSCPropNetProxiesHTTPEnable })
        && !flag(unsafe { kSCPropNetProxiesHTTPSEnable })
    {
        return BypassRules::default();
    }
    let exceptions = proxies
        .find(unsafe { kSCPropNetProxiesExceptionsList })
        .and_then(|v| v.downcast::<CFArray>())
        .map(|list| {
            list.iter()
                // SAFETY: the array's items are CF objects it keeps alive while `list` lives;
                // get-rule wrapping retains each one for the downcast.
                .filter_map(|item| {
                    unsafe { CFType::wrap_under_get_rule(*item) }.downcast::<CFString>()
                })
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    BypassRules {
        simple_hostnames: flag(unsafe { kSCPropNetProxiesExcludeSimpleHostnames }),
        exceptions,
    }
}

/// The shared HTTP client's proxy, with loopback going direct. Adding any proxy turns reqwest's
/// implicit system one off, so this is the client's whole proxy decision.
///
/// `Matcher::from_system()` is read per decision, not once: the client lives as long as the app,
/// and a Windows / macOS proxy switched on, off or changed while it runs must reach the HTTP routes
/// as it reaches dictation ([`system_route`]). A read is a few env lookups plus one registry key
/// (Windows) or one SCDynamicStore copy (macOS), noise next to a request.
///
/// A pooled keep-alive connection still keeps the route it was opened on: hyper-util pools by the
/// server's scheme + host + port, not by the proxy, so the new setting applies to the next new
/// connection — after the 90 s idle timeout, a server close, or for another server.
pub(super) fn system_client_proxy() -> reqwest::Proxy {
    client_proxy(|| (Matcher::from_system(), BypassRules::system()))
}

/// `source` is asked for the matcher and the OS bypass rules on every decision (tests pass fixed
/// ones).
fn client_proxy(
    source: impl Fn() -> (Matcher, BypassRules) + Send + Sync + 'static,
) -> reqwest::Proxy {
    reqwest::Proxy::custom(move |url| {
        let host = url.host_str()?;
        if is_loopback_host(host) {
            return None;
        }
        let (matcher, rules) = source();
        if bypass(host, &rules) {
            return None;
        }
        let hit = matcher.intercept(&url.as_str().parse().ok()?)?;
        // hyper-util moved the login out of the URI; reqwest reads it back only from the returned
        // URL's userinfo, so it goes back there or every proxied request would lose its login.
        let mut proxy = reqwest::Url::parse(&hit.uri().to_string()).ok()?;
        let login = match hit.raw_auth() {
            Some((user, pass)) => Some((user.to_owned(), pass.to_owned())),
            None => hit.basic_auth().and_then(decode_basic),
        };
        if let Some((user, pass)) = login {
            // reqwest percent-decodes this URL once more, and the url crate never escapes `%`.
            proxy.set_username(&user.replace('%', "%25")).ok()?;
            proxy.set_password(Some(&pass.replace('%', "%25"))).ok()?;
        }
        Some(proxy)
    })
}

/// `Basic base64(user:pass)` back to its parts. Exact: RFC 7617 bars `:` from the user-id, and
/// reqwest re-encodes the pair into the very same header.
fn decode_basic(header: &HeaderValue) -> Option<(String, String)> {
    use base64::Engine;
    let encoded = header.to_str().ok()?.strip_prefix("Basic ")?;
    let decoded = base64::prelude::BASE64_STANDARD.decode(encoded).ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (user, pass) = decoded.split_once(':')?;
    Some((user.to_owned(), pass.to_owned()))
}

/// The system proxy for the stream URL, if one applies — `Matcher::from_system()` read fresh per
/// connect, as the HTTP client reads it per decision ([`system_client_proxy`]).
pub(super) fn system_route(ws_url: &str) -> Option<Proxy> {
    route(&Matcher::from_system(), &BypassRules::system(), ws_url)
}

/// The proxy `matcher` sends `ws_url` through, if any. ws:// is matched as http:// and wss:// as
/// https://, so HTTP_PROXY / HTTPS_PROXY split the same way they do for the HTTP routes. A
/// loopback server or one the OS `rules` exempt is never proxied (see [`is_loopback_host`],
/// [`BypassRules`]).
///
/// Only a plain http:// proxy is dialled. An https:// proxy (TLS to the proxy itself) or a SOCKS one
/// would need a second TLS layer or a SOCKS handshake this route does not have — and reqwest here
/// has no `socks` feature either — so such a proxy is skipped with a warning and the socket
/// connects directly.
fn route(matcher: &Matcher, rules: &BypassRules, ws_url: &str) -> Option<Proxy> {
    let url = reqwest::Url::parse(ws_url).ok()?;
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return None,
    };
    if is_loopback_host(url.host_str()?) || bypass(url.host_str()?, rules) {
        return None;
    }
    let target: Uri = format!(
        "{scheme}://{}:{}/",
        url.host_str()?,
        url.port_or_known_default()?
    )
    .parse()
    .ok()?;
    let hit = matcher.intercept(&target)?;
    if hit.uri().scheme_str() != Some("http") {
        let shown = super::bounded_server_text(
            &format!(
                "{}://{}",
                hit.uri().scheme_str().unwrap_or(""),
                hit.uri().authority().map_or("", |a| a.as_str())
            ),
            80,
        );
        tracing::warn!(
            "[stream] live dictation cannot use the proxy {shown} (only http:// proxies are \
             supported for the WebSocket); connecting directly"
        );
        return None;
    }
    Some(Proxy {
        uri: hit.uri().clone(),
        auth: hit.basic_auth().cloned(),
        target,
    })
}

/// Opens the stream socket: a CONNECT tunnel through `proxy` when there is one, then the same TLS +
/// WebSocket handshake either way; no proxy is exactly the direct `connect_async` path. The error
/// names the proxy (never its login) when the proxy is what failed.
///
/// A proxy that answers the CONNECT with a refusal other than 407 gets one direct attempt: a
/// stock Squid (`deny CONNECT !SSL_ports`) refuses a tunnel to any port but 443 while it forwards
/// (not tunnels) the HTTP routes to the same server. A 407 (a login to fix) and a proxy that
/// cannot be reached or answers garbage fail outright.
pub(super) async fn connect(
    request: Request,
    config: WebSocketConfig,
    tls: Option<Connector>,
    proxy: Option<&Proxy>,
) -> Result<(WebSocketStream<MaybeTlsStream<TcpStream>>, Response), String> {
    let direct = |request, tls| async move {
        tokio_tungstenite::connect_async_tls_with_config(request, Some(config), false, tls)
            .await
            .map_err(|e| e.to_string())
    };
    let Some(proxy) = proxy else {
        return direct(request, tls).await;
    };
    let stream = match tunnel(proxy).await {
        Ok(stream) => stream,
        Err(Tunnel::Refused(why)) => {
            tracing::warn!("[stream] {why}; connecting directly");
            return direct(request, tls)
                .await
                .map_err(|e| format!("{e} (directly, after {why})"));
        }
        Err(Tunnel::Failed(why)) => return Err(why),
    };
    tokio_tungstenite::client_async_tls_with_config(request, stream, Some(config), tls)
        .await
        .map_err(|e| format!("{e} (through the proxy {})", proxy.display()))
}

/// Why [`tunnel`] has no stream; both carry the user-facing text, naming the proxy.
enum Tunnel {
    /// The proxy answered the CONNECT with a non-2xx status other than 407.
    Refused(String),
    /// Anything else: unreachable, a 407, a broken or non-HTTP reply.
    Failed(String),
}

/// The CONNECT handshake, by hand: hyper-util's `Tunnel` would do it, but it hides `TunnelError`
/// and folds every non-407 refusal into "unsuccessful", so the user could never be told the proxy
/// answered 403. The proxy's port defaults to 80 when the URL names none, as reqwest's connector
/// does.
async fn tunnel(proxy: &Proxy) -> Result<TcpStream, Tunnel> {
    let shown = proxy.display();
    let host = unbracketed(proxy.uri.host().unwrap_or_default());
    let port = proxy.uri.port_u16().unwrap_or(80);
    let mut stream = TcpStream::connect((host, port))
        .await
        .map_err(|e| Tunnel::Failed(format!("could not reach the proxy {shown}: {e}")))?;
    let target = format!(
        "{}:{}",
        proxy.target.host().unwrap_or_default(),
        proxy.target.port_u16().unwrap_or(443)
    );
    let mut head = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n").into_bytes();
    if let Some(auth) = &proxy.auth {
        head.extend_from_slice(b"Proxy-Authorization: ");
        head.extend_from_slice(auth.as_bytes());
        head.extend_from_slice(b"\r\n");
    }
    head.extend_from_slice(b"\r\n");
    let io_err = |e: std::io::Error| {
        Tunnel::Failed(format!("the tunnel through the proxy {shown} failed: {e}"))
    };
    stream.write_all(&head).await.map_err(io_err)?;

    // One byte at a time so nothing past the reply's blank line is consumed: every byte after it
    // belongs to the TLS / WebSocket handshake that runs on this same socket. A handful of reads,
    // once per session. Bounded, so a proxy that never ends its headers cannot grow this.
    let mut reply = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !reply.ends_with(b"\r\n\r\n") {
        if reply.len() >= MAX_CONNECT_REPLY {
            return Err(Tunnel::Failed(format!(
                "the proxy {shown} sent an oversized reply to the tunnel request"
            )));
        }
        if stream.read(&mut byte).await.map_err(io_err)? == 0 {
            return Err(Tunnel::Failed(format!(
                "the proxy {shown} closed the connection before opening the tunnel"
            )));
        }
        reply.push(byte[0]);
    }
    let status_line = String::from_utf8_lossy(&reply);
    let status_line = status_line.lines().next().unwrap_or_default();
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or_default();
    let code = parts.next().and_then(|c| c.parse::<u16>().ok());
    match code {
        Some(200..=299) if version.starts_with("HTTP/1.") => Ok(stream),
        Some(407) if proxy.auth.is_some() => Err(Tunnel::Failed(format!(
            "the proxy {shown} rejected its login (407)"
        ))),
        Some(407) => Err(Tunnel::Failed(format!(
            "the proxy {shown} requires a login (407); put it in the proxy URL as user:password@"
        ))),
        Some(code) => {
            let reason = super::bounded_server_text(parts.next().unwrap_or_default(), 60);
            Err(Tunnel::Refused(format!(
                "the proxy {shown} refused to open a tunnel to the server ({code} {reason})"
            )))
        }
        None => Err(Tunnel::Failed(format!(
            "the proxy {shown} answered the tunnel request with something other than HTTP"
        ))),
    }
}

/// hyper-util's own bound for the same reply.
const MAX_CONNECT_REPLY: usize = 8192;

#[cfg(test)]
mod tests {
    use super::{bypass, client_proxy, connect, is_loopback_host, BypassRules, Matcher};
    use futures_util::{SinkExt, StreamExt};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
    use tokio_tungstenite::tungstenite::Message;

    /// The route with no OS bypass rules, which every test but the bypass ones wants.
    fn route(matcher: &Matcher, ws_url: &str) -> Option<super::Proxy> {
        super::route(matcher, &BypassRules::default(), ws_url)
    }

    /// A one-session plain ws:// server that echoes the first text frame.
    async fn echo_server() -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            if let Some(Ok(m)) = ws.next().await {
                let _ = ws.send(m).await;
            }
        });
        addr
    }

    /// A one-shot fake HTTP proxy: records the CONNECT request head, answers with `reply`, and on a
    /// 200 pipes the client through to the loopback port the CONNECT line names.
    async fn fake_proxy(reply: &'static str) -> (String, Arc<Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(String::new()));
        let sink = seen.clone();
        tokio::spawn(async move {
            let (mut client, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if client.read(&mut byte).await.unwrap() == 0 {
                    return;
                }
                head.push(byte[0]);
            }
            let head = String::from_utf8(head).unwrap();
            *sink.lock().unwrap() = head.clone();
            client.write_all(reply.as_bytes()).await.unwrap();
            if !reply.starts_with("HTTP/1.1 200") {
                return;
            }
            // Loopback is never proxied, so the tests name the server `echo.test`; only the port
            // is real.
            let target = head.split(' ').nth(1).unwrap();
            let port = target.rsplit(':').next().unwrap();
            let mut upstream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
                .await
                .unwrap();
            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
        });
        (format!("http://{addr}"), seen)
    }

    async fn round_trip(ws_url: &str, matcher: &Matcher) -> Result<String, String> {
        let proxy = route(matcher, ws_url);
        let request = ws_url.into_client_request().unwrap();
        let (mut ws, _) =
            connect(request, WebSocketConfig::default(), None, proxy.as_ref()).await?;
        ws.send(Message::Text("hello".into())).await.unwrap();
        match ws.next().await {
            Some(Ok(Message::Text(t))) => Ok(t.to_string()),
            other => Err(format!("{other:?}")),
        }
    }

    #[tokio::test]
    async fn the_websocket_handshake_completes_through_a_connect_tunnel() {
        let server = echo_server().await;
        let (proxy, seen) = fake_proxy("HTTP/1.1 200 Connection established\r\n\r\n").await;
        let ws_url = format!(
            "ws://echo.test:{}/v1/audio/transcriptions/stream",
            server.port()
        );
        let matcher = Matcher::builder().all(proxy.as_str()).build();
        assert_eq!(round_trip(&ws_url, &matcher).await.unwrap(), "hello");
        let head = seen.lock().unwrap().clone();
        assert!(
            head.starts_with(&format!("CONNECT echo.test:{} HTTP/1.1\r\n", server.port())),
            "{head}"
        );
        assert!(
            !head.to_ascii_lowercase().contains("proxy-authorization"),
            "{head}"
        );
    }

    #[tokio::test]
    async fn the_proxy_login_rides_the_connect_as_basic() {
        let server = echo_server().await;
        let (proxy, seen) = fake_proxy("HTTP/1.1 200 Connection established\r\n\r\n").await;
        let ws_url = format!("ws://echo.test:{}/x", server.port());
        let with_login = proxy.replace("http://", "http://u:p@");
        let matcher = Matcher::builder().all(with_login.as_str()).build();
        assert_eq!(round_trip(&ws_url, &matcher).await.unwrap(), "hello");
        let head = seen.lock().unwrap().to_ascii_lowercase();
        assert!(
            head.contains("proxy-authorization: basic dtpw\r\n"),
            "{head}"
        );
    }

    /// NO_PROXY wins, as it does for reqwest: no tunnel, the socket goes straight to the server.
    #[tokio::test]
    async fn a_no_proxy_host_connects_directly() {
        let server = echo_server().await;
        let ws_url = format!("ws://{server}/x");
        let matcher = Matcher::builder()
            .all("http://127.0.0.1:9")
            .no("127.0.0.1")
            .build();
        assert!(route(&matcher, &ws_url).is_none());
        assert_eq!(round_trip(&ws_url, &matcher).await.unwrap(), "hello");
        // A non-loopback NO_PROXY host too, so the exemption is not just the loopback bypass.
        let matcher = Matcher::builder()
            .all("http://127.0.0.1:9")
            .no("gpu-box.test")
            .build();
        assert!(route(&matcher, "ws://gpu-box.test:8000/x").is_none());
        assert!(route(&matcher, "ws://other.test:8000/x").is_some());
        // And with nothing configured at all.
        let server = echo_server().await;
        let ws_url = format!("ws://{server}/x");
        let none = Matcher::builder().build();
        assert!(route(&none, &ws_url).is_none());
        assert_eq!(round_trip(&ws_url, &none).await.unwrap(), "hello");
    }

    #[tokio::test]
    async fn a_407_names_the_proxy_without_its_password() {
        let (proxy, _) = fake_proxy(
            "HTTP/1.1 407 Proxy Authentication Required\r\n\
             Proxy-Authenticate: Basic realm=\"x\"\r\nContent-Length: 0\r\n\r\n",
        )
        .await;
        let with_login = proxy.replace("http://", "http://alice:s3cret@");
        let matcher = Matcher::builder().all(with_login.as_str()).build();
        let err = round_trip("wss://server.example:8443/x", &matcher)
            .await
            .unwrap_err();
        assert!(err.contains(&proxy), "{err}");
        assert!(err.contains("407"), "{err}");
        assert!(!err.contains("s3cret") && !err.contains("alice"), "{err}");
    }

    /// A stock Squid (`deny CONNECT !SSL_ports`) answers 403 to a CONNECT for the server's port
    /// 8000 while it forward-proxies the HTTP routes fine: dictation then tries the server
    /// directly once instead of failing where Test connection passed.
    #[tokio::test]
    async fn a_refused_tunnel_falls_back_to_a_direct_connection() {
        let server = echo_server().await;
        let (proxy, seen) = fake_proxy("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n").await;
        let matcher = Matcher::builder().all(proxy.as_str()).build();
        // Loopback is never routed, so the route is taken for a made-up name on the same port and
        // the direct attempt dials the real loopback server.
        let route = route(&matcher, &format!("ws://echo.test:{}/x", server.port())).unwrap();
        let request = format!("ws://{server}/x").into_client_request().unwrap();
        let (mut ws, _) = connect(request, WebSocketConfig::default(), None, Some(&route))
            .await
            .unwrap();
        ws.send(Message::Text("hello".into())).await.unwrap();
        assert!(matches!(ws.next().await, Some(Ok(Message::Text(t))) if t == "hello"));
        assert!(seen.lock().unwrap().starts_with("CONNECT "));
    }

    /// A 407 is a login to fix, not a policy to route around: no direct attempt, even when the
    /// server could be reached.
    #[tokio::test]
    async fn a_407_does_not_fall_back_to_direct() {
        let server = echo_server().await;
        let (proxy, _) =
            fake_proxy("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
                .await;
        let matcher = Matcher::builder().all(proxy.as_str()).build();
        let route = route(&matcher, &format!("ws://echo.test:{}/x", server.port())).unwrap();
        let request = format!("ws://{server}/x").into_client_request().unwrap();
        let err = connect(request, WebSocketConfig::default(), None, Some(&route))
            .await
            .unwrap_err();
        assert!(err.contains(&proxy) && err.contains("407"), "{err}");
    }

    /// When the direct attempt after a refusal fails too, the error still carries the proxy's
    /// status, so a proxy policy block reads as one.
    #[tokio::test]
    async fn a_refused_tunnel_keeps_the_proxy_status() {
        let (proxy, _) = fake_proxy("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n").await;
        let matcher = Matcher::builder().all(proxy.as_str()).build();
        let err = round_trip("ws://server.example:8000/x", &matcher)
            .await
            .unwrap_err();
        assert!(
            err.contains(&proxy) && err.contains("403 Forbidden"),
            "{err}"
        );
    }

    #[test]
    fn wss_matches_as_https_and_ws_as_http() {
        let matcher = Matcher::builder().https("http://p:3128").build();
        let p = route(&matcher, "wss://h/x").unwrap();
        assert_eq!(p.display(), "http://p:3128");
        assert_eq!(p.target.to_string(), "https://h:443/");
        assert!(route(&matcher, "ws://h/x").is_none());
        let matcher = Matcher::builder().http("http://p:3128").build();
        assert_eq!(
            route(&matcher, "ws://h/x").unwrap().target.to_string(),
            "http://h:80/"
        );
        assert!(route(&matcher, "wss://h/x").is_none());
    }

    /// The tunnel has no TLS-to-proxy or SOCKS layer: such a proxy is skipped, not half-used.
    #[test]
    fn https_and_socks_proxies_fall_back_to_direct() {
        for p in ["https://p:3128", "socks5://p:1080", "socks5h://u:pw@p:1080"] {
            let matcher = Matcher::builder().all(p).build();
            assert!(route(&matcher, "wss://h/x").is_none(), "{p}");
        }
    }

    #[test]
    fn loopback_hosts_are_recognised() {
        for h in [
            "localhost",
            "LocalHost",
            "localhost.",
            "app.localhost",
            "127.0.0.1",
            "127.4.5.6",
            "127.255.255.255",
            "::1",
            "[::1]",
            "0.0.0.0",
            "0.1.2.3",
            "::",
            "[::]",
            "[::ffff:127.0.0.1]",
            "::ffff:0.0.0.0",
        ] {
            assert!(is_loopback_host(h), "{h}");
        }
        for h in [
            "localhost.example.com",
            "mylocalhost",
            "127.example",
            "::2",
            "[::2]",
            "128.0.0.1",
            "126.255.255.255",
            "1.0.0.0",
            "10.0.0.1",
            "192.168.1.5",
            "[::ffff:10.0.0.1]",
            "gpu-box",
            "",
        ] {
            assert!(!is_loopback_host(h), "{h}");
        }
    }

    /// A system proxy has no implicit loopback bypass in hyper-util, so the route adds it.
    #[test]
    fn a_loopback_server_is_never_proxied() {
        let matcher = Matcher::builder()
            .http("http://proxy.test:3128")
            .https("http://proxy.test:3128")
            .build();
        for url in [
            "ws://localhost:8000/x",
            "ws://127.0.0.1:8000/x",
            "ws://127.4.5.6:8000/x",
            "ws://[::1]:8000/x",
            "wss://localhost/x",
        ] {
            assert!(route(&matcher, url).is_none(), "{url}");
        }
        let p = route(&matcher, "ws://gpu-box:8000/x").unwrap();
        assert_eq!(p.display(), "http://proxy.test:3128");
    }

    /// A one-shot HTTP/1.1 listener: records the request head, answers `ok`.
    async fn http_ok() -> (std::net::SocketAddr, Arc<Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(String::new()));
        let sink = seen.clone();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if s.read(&mut byte).await.unwrap() == 0 {
                    return;
                }
                head.push(byte[0]);
            }
            *sink.lock().unwrap() = String::from_utf8(head).unwrap();
            let _ = s
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await;
        });
        (addr, seen)
    }

    fn client_via(source: impl Fn() -> Matcher + Send + Sync + 'static) -> reqwest::Client {
        client_with_rules(move || (source(), BypassRules::default()))
    }

    fn client_with_rules(
        source: impl Fn() -> (Matcher, BypassRules) + Send + Sync + 'static,
    ) -> reqwest::Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .proxy(client_proxy(source))
            .build()
            .unwrap()
    }

    /// GETs `url` through `client` and returns the body: the fake listeners answer `ok`.
    async fn get_body(client: &reqwest::Client, url: impl reqwest::IntoUrl) -> String {
        client.get(url).send().await.unwrap().text().await.unwrap()
    }

    /// The one client lives as long as the app, so a system proxy switched on or off while it runs
    /// must reach its next request — as it reaches the next dictation — not wait for a restart.
    #[tokio::test]
    async fn the_client_follows_a_proxy_switched_on_and_off_after_it_was_built() {
        let setting: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let read = setting.clone();
        let client = client_via(move || match read.lock().unwrap().as_deref() {
            Some(proxy) => Matcher::builder().all(proxy).build(),
            None => Matcher::builder().build(),
        });
        let url = "http://gpu-box.test:8000/health";
        let err = client.get(url).send().await.unwrap_err();
        assert!(format!("{err:?}").contains("dns error"), "{err:?}");

        let (proxy, seen) = http_ok().await;
        *setting.lock().unwrap() = Some(format!("http://{proxy}"));
        let body = get_body(&client, url).await;
        assert_eq!(body, "ok");
        let head = seen.lock().unwrap().to_ascii_lowercase();
        assert!(
            head.starts_with("get http://gpu-box.test:8000/health"),
            "{head}"
        );

        // The fake proxy answered with `Connection: close`, so no pooled connection carries the
        // old route over; switched off, the request resolves the server itself again (a dns
        // error for this made-up host — a stale proxy route would be refused at the proxy's port).
        *setting.lock().unwrap() = None;
        let err = client.get(url).send().await.unwrap_err();
        assert!(format!("{err:?}").contains("dns error"), "{err:?}");
    }

    /// The HTTP client forwards through the system proxy with the proxy's login intact — the very
    /// header the WebSocket's CONNECT carries — even when user and password need percent-encoding.
    #[tokio::test]
    async fn the_client_proxies_a_remote_host_with_its_login() {
        let (proxy, seen) = http_ok().await;
        let proxy_url = format!("http://al%40ice:p%40ss%3Aw%25rd@{proxy}");
        let expected = Matcher::builder()
            .all(proxy_url.as_str())
            .build()
            .intercept(&"http://gpu-box.test/".parse().unwrap())
            .unwrap()
            .basic_auth()
            .unwrap()
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        let client = client_via(move || Matcher::builder().all(proxy_url.as_str()).build());
        let body = get_body(&client, "http://gpu-box.test:8000/health").await;
        assert_eq!(body, "ok");
        let head = seen.lock().unwrap().to_ascii_lowercase();
        assert!(
            head.starts_with("get http://gpu-box.test:8000/health http/1.1\r\n"),
            "{head}"
        );
        assert!(
            head.contains(&format!("proxy-authorization: {expected}\r\n")),
            "{head}"
        );
    }

    /// A `%` in the login reaches the proxy as a `%`: the system matcher hands it over decoded and
    /// reqwest's custom proxy decodes the returned URL once more, so `%41` must not become `A`.
    #[tokio::test]
    async fn a_percent_in_the_proxy_login_survives_the_second_decode() {
        use base64::Engine;
        let (proxy, seen) = http_ok().await;
        let proxy_url = format!("http://a%2541%40b:x%259Fy%3A%40z@{proxy}");
        let client = client_via(move || Matcher::builder().all(proxy_url.as_str()).build());
        let body = get_body(&client, "http://gpu-box.test:8000/health").await;
        assert_eq!(body, "ok");
        let expected = base64::prelude::BASE64_STANDARD.encode("a%41@b:x%9Fy:@z");
        let head = seen.lock().unwrap().clone();
        assert!(
            head.to_ascii_lowercase().contains(&format!(
                "proxy-authorization: basic {}\r\n",
                expected.to_ascii_lowercase()
            )),
            "{head}"
        );
    }

    /// Loopback goes straight to the server even with a (dead) proxy configured for everything,
    /// and NO_PROXY still exempts a host the system matcher lists.
    #[tokio::test]
    async fn the_client_reaches_loopback_and_no_proxy_hosts_directly() {
        let (server, seen) = http_ok().await;
        let client = client_via(move || Matcher::builder().all("http://u:p@127.0.0.1:9").build());
        let url = format!("http://localhost:{}/health", server.port());
        assert_eq!(get_body(&client, url).await, "ok");
        let head = seen.lock().unwrap().to_ascii_lowercase();
        assert!(head.starts_with("get /health http/1.1\r\n"), "{head}");
        assert!(!head.contains("proxy-authorization"), "{head}");

        let (proxy, via_proxy) = http_ok().await;
        let client = client_via(move || {
            Matcher::builder()
                .all(format!("http://{proxy}").as_str())
                .no("gpu-box.test")
                .build()
        });
        let err = client.get("http://gpu-box.test:8000/").send().await;
        assert!(err.is_err(), "a NO_PROXY host must not reach the proxy");
        assert!(via_proxy.lock().unwrap().is_empty());
    }
    fn mac_rules(simple: bool, exceptions: &[&str]) -> BypassRules {
        BypassRules {
            simple_hostnames: simple,
            exceptions: exceptions.iter().map(|e| (*e).to_owned()).collect(),
        }
    }

    /// WinINet's `<local>`: a name without a dot goes direct; a dotted name or an IP literal does
    /// not.
    #[test]
    fn windows_local_bypasses_dotless_names_only() {
        // What hyper-util makes of `*.corp;<local>`: `corp,<local>`, and `<local>` matches nothing.
        let hyper = Matcher::builder()
            .all("http://proxy.test:3128")
            .no("corp,<local>")
            .build();
        assert!(hyper
            .intercept(&"http://gpu-server:8000/".parse().unwrap())
            .is_some());
        assert!(hyper
            .intercept(&"http://a.corp:8000/".parse().unwrap())
            .is_none());

        let rules = BypassRules::from_windows_override("*.corp; 10.*;<LOCAL>");
        for h in ["gpu-server", "GPU-Server", "gpu-server.", "intranet"] {
            assert!(bypass(h, &rules), "{h}");
        }
        for h in [
            "gpu-server.corp",
            "10.0.0.5",
            "::2",
            "[fe80::1]",
            "example.com",
            "",
        ] {
            assert!(!bypass(h, &rules), "{h}");
        }
        // Without the entry, and with lookalikes, nothing extra goes direct.
        for value in ["", "*.corp;10.*", "<local>.corp", "local", "<-loopback>"] {
            let rules = BypassRules::from_windows_override(value);
            assert!(!bypass("gpu-server", &rules), "{value}");
        }
    }

    /// macOS ExceptionsList entries as the Network pane writes them, plus ExcludeSimpleHostnames.
    #[test]
    fn macos_exceptions_match_globs_and_ranges() {
        let rules = mac_rules(
            false,
            &[
                "*.local",
                "169.254/16",
                "gpu.example",
                "*corp*",
                ".lab.test",
                "10.1.2.3",
                "fd00::/8",
                " 192.168.0.0/16 ",
            ],
        );
        for h in [
            "printer.local",
            "a.b.LOCAL",
            "169.254.3.4",
            "gpu.example",
            "box.mycorp.net",
            "x.lab.test",
            "10.1.2.3",
            "[fd12::5]",
            "192.168.44.1",
        ] {
            assert!(bypass(h, &rules), "{h}");
        }
        for h in [
            "local",
            "169.255.0.1",
            "www.gpu.example",
            "lab.test",
            "10.1.2.4",
            "[fe80::1]",
            "gpu-server",
            "example.com",
        ] {
            assert!(!bypass(h, &rules), "{h}");
        }
        let simple = mac_rules(true, &[]);
        assert!(bypass("gpu-server", &simple));
        assert!(!bypass("gpu-server.corp", &simple) && !bypass("10.0.0.5", &simple));
        assert!(!bypass("gpu-server", &mac_rules(false, &[])));
    }

    /// Both halves honour the OS rules: the dictation route skips the proxy and the HTTP client
    /// reaches the server itself even with a (recording) proxy configured for everything.
    #[tokio::test]
    async fn an_os_bypassed_host_goes_direct_on_both_halves() {
        let all = || Matcher::builder().all("http://127.0.0.1:9").build();
        let local = BypassRules::from_windows_override("<local>");
        assert!(super::route(&all(), &local, "ws://gpu-server:8000/x").is_none());
        assert!(super::route(&all(), &local, "ws://gpu-server.corp:8000/x").is_some());
        let mac = mac_rules(false, &["*.lab.test"]);
        assert!(super::route(&all(), &mac, "wss://gpu.lab.test/x").is_none());

        let (proxy, via_proxy) = http_ok().await;
        let client = client_with_rules(move || {
            (
                Matcher::builder()
                    .all(format!("http://{proxy}").as_str())
                    .build(),
                BypassRules::from_windows_override("*.corp;<local>"),
            )
        });
        // Direct means resolving the made-up name itself: a dns error, and the proxy never asked.
        let err = client
            .get("http://gpu-server:8000/health")
            .send()
            .await
            .unwrap_err();
        assert!(format!("{err:?}").contains("dns error"), "{err:?}");
        assert!(via_proxy.lock().unwrap().is_empty());
        // A dotted name still takes the proxy.
        let body = get_body(&client, "http://gpu-server.test:8000/health").await;
        assert_eq!(body, "ok");
        let head = via_proxy.lock().unwrap().to_ascii_lowercase();
        assert!(
            head.starts_with("get http://gpu-server.test:8000/health"),
            "{head}"
        );
    }
}
