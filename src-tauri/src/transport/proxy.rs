//! The live-dictation WebSocket's proxy route.
//!
//! tungstenite dials the server directly, so before this the socket ignored every proxy the HTTP
//! routes honour — a dictation behind a corporate proxy failed while Test connection and batch
//! runs passed. The decision here is reqwest's own (hyper-util's `Matcher`: the
//! HTTP(S)_PROXY / ALL_PROXY / NO_PROXY env vars, then the Windows / macOS proxy settings), so
//! both halves of the transport go the same way; the socket then tunnels with HTTP CONNECT.
//! A loopback server is always dialled directly by both halves, as WinINet and CFNetwork do,
//! because hyper-util's system matcher has no such bypass and a proxy cannot reach our loopback.

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

/// A loopback host: `localhost` / `*.localhost`, 127.0.0.0/8, or `::1` (bracketed or not). Both
/// the HTTP client and the WebSocket send these direct whatever the proxy settings say.
pub(super) fn is_loopback_host(host: &str) -> bool {
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip.is_loopback();
    }
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    host == "localhost" || host.ends_with(".localhost")
}

/// The shared HTTP client's proxy: `Matcher::from_system()` read once, as reqwest's implicit
/// system proxy read it once per client, with loopback going direct. Adding any proxy turns that
/// implicit one off in reqwest, so this is the client's whole proxy decision.
pub(super) fn system_client_proxy() -> reqwest::Proxy {
    client_proxy(Matcher::from_system())
}

fn client_proxy(matcher: Matcher) -> reqwest::Proxy {
    reqwest::Proxy::custom(move |url| {
        if is_loopback_host(url.host_str()?) {
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
            proxy.set_username(&user).ok()?;
            proxy.set_password(Some(&pass)).ok()?;
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
/// connect, as reqwest reads it per client.
pub(super) fn system_route(ws_url: &str) -> Option<Proxy> {
    route(&Matcher::from_system(), ws_url)
}

/// The proxy `matcher` sends `ws_url` through, if any. ws:// is matched as http:// and wss:// as
/// https://, so HTTP_PROXY / HTTPS_PROXY split the same way they do for the HTTP routes. A
/// loopback server is never proxied (see [`is_loopback_host`]).
///
/// Only a plain http:// proxy is dialled. An https:// proxy (TLS to the proxy itself) or a SOCKS one
/// would need a second TLS layer or a SOCKS handshake this route does not have — and reqwest here
/// has no `socks` feature either — so such a proxy is skipped with a warning and the socket
/// connects directly, which is what it did for every proxy before.
fn route(matcher: &Matcher, ws_url: &str) -> Option<Proxy> {
    let url = reqwest::Url::parse(ws_url).ok()?;
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return None,
    };
    if is_loopback_host(url.host_str()?) {
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
pub(super) async fn connect(
    request: Request,
    config: WebSocketConfig,
    tls: Option<Connector>,
    proxy: Option<&Proxy>,
) -> Result<(WebSocketStream<MaybeTlsStream<TcpStream>>, Response), String> {
    let Some(proxy) = proxy else {
        return tokio_tungstenite::connect_async_tls_with_config(request, Some(config), false, tls)
            .await
            .map_err(|e| e.to_string());
    };
    let stream = tunnel(proxy).await?;
    tokio_tungstenite::client_async_tls_with_config(request, stream, Some(config), tls)
        .await
        .map_err(|e| format!("{e} (through the proxy {})", proxy.display()))
}

/// The CONNECT handshake, by hand: hyper-util's `Tunnel` would do it, but it hides `TunnelError`
/// and folds every non-407 refusal into "unsuccessful", so the user could never be told the proxy
/// answered 403. The proxy's port defaults to 80 when the URL names none, as reqwest's connector
/// does.
async fn tunnel(proxy: &Proxy) -> Result<TcpStream, String> {
    let shown = proxy.display();
    let host = proxy.uri.host().unwrap_or_default();
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    let port = proxy.uri.port_u16().unwrap_or(80);
    let mut stream = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("could not reach the proxy {shown}: {e}"))?;
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
    let io_err = |e: std::io::Error| format!("the tunnel through the proxy {shown} failed: {e}");
    stream.write_all(&head).await.map_err(io_err)?;

    // One byte at a time so nothing past the reply's blank line is consumed: every byte after it
    // belongs to the TLS / WebSocket handshake that runs on this same socket. A handful of reads,
    // once per session. Bounded, so a proxy that never ends its headers cannot grow this.
    let mut reply = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !reply.ends_with(b"\r\n\r\n") {
        if reply.len() >= MAX_CONNECT_REPLY {
            return Err(format!(
                "the proxy {shown} sent an oversized reply to the tunnel request"
            ));
        }
        if stream.read(&mut byte).await.map_err(io_err)? == 0 {
            return Err(format!(
                "the proxy {shown} closed the connection before opening the tunnel"
            ));
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
        Some(407) if proxy.auth.is_some() => {
            Err(format!("the proxy {shown} rejected its login (407)"))
        }
        Some(407) => Err(format!(
            "the proxy {shown} requires a login (407); put it in the proxy URL as user:password@"
        )),
        Some(code) => {
            let reason = super::bounded_server_text(parts.next().unwrap_or_default(), 60);
            Err(format!(
                "the proxy {shown} refused to open a tunnel to the server ({code} {reason})"
            ))
        }
        None => Err(format!(
            "the proxy {shown} answered the tunnel request with something other than HTTP"
        )),
    }
}

/// hyper-util's own bound for the same reply.
const MAX_CONNECT_REPLY: usize = 8192;

#[cfg(test)]
mod tests {
    use super::{client_proxy, connect, is_loopback_host, route, Matcher};
    use futures_util::{SinkExt, StreamExt};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
    use tokio_tungstenite::tungstenite::Message;

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

    /// Any other refusal keeps its status, so a proxy policy block reads as one.
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
            "0.0.0.0",
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

    fn client_via(matcher: Matcher) -> reqwest::Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .proxy(client_proxy(matcher))
            .build()
            .unwrap()
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
        let client = client_via(Matcher::builder().all(proxy_url.as_str()).build());
        let body = client
            .get("http://gpu-box.test:8000/health")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
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

    /// Loopback goes straight to the server even with a (dead) proxy configured for everything,
    /// and NO_PROXY still exempts a host the system matcher lists.
    #[tokio::test]
    async fn the_client_reaches_loopback_and_no_proxy_hosts_directly() {
        let (server, seen) = http_ok().await;
        let client = client_via(Matcher::builder().all("http://u:p@127.0.0.1:9").build());
        let url = format!("http://localhost:{}/health", server.port());
        assert_eq!(
            client.get(url).send().await.unwrap().text().await.unwrap(),
            "ok"
        );
        let head = seen.lock().unwrap().to_ascii_lowercase();
        assert!(head.starts_with("get /health http/1.1\r\n"), "{head}");
        assert!(!head.contains("proxy-authorization"), "{head}");

        let (proxy, via_proxy) = http_ok().await;
        let matcher = Matcher::builder()
            .all(format!("http://{proxy}").as_str())
            .no("gpu-box.test")
            .build();
        let client = client_via(matcher);
        let err = client.get("http://gpu-box.test:8000/").send().await;
        assert!(err.is_err(), "a NO_PROXY host must not reach the proxy");
        assert!(via_proxy.lock().unwrap().is_empty());
    }
}
