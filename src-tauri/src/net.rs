use crate::secrets;
use crate::storage::NativeError;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;

const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const FORBIDDEN_HEADERS: [&str; 4] = ["authorization", "proxy-authorization", "cookie", "host"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestSpec {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    bearer_from_secret: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HttpEvent {
    Head {
        status: u16,
        headers: Vec<(String, String)>,
    },
    Chunk {
        data: Vec<u8>,
    },
    End,
    Error {
        kind: &'static str,
        message: String,
    },
}

pub struct Http {
    client: Client,
    tasks: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

impl Http {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("PLuMS/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            tasks: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}

fn invalid(message: &str) -> NativeError {
    NativeError::new("invalid-request", message)
}

/// Builds a validated request. The bearer secret is resolved here, for exactly this URL.
fn build(client: &Client, spec: HttpRequestSpec) -> Result<reqwest::RequestBuilder, NativeError> {
    let url = secrets::validate_endpoint(&spec.url)?;
    let method = match spec.method.as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => return Err(invalid("Alleen GET en POST zijn toegestaan.")),
    };
    let mut headers = HeaderMap::new();
    for (name, value) in &spec.headers {
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid("Ongeldige header."))?;
        if FORBIDDEN_HEADERS.contains(&name.as_str()) {
            return Err(invalid("Deze header mag niet worden meegestuurd."));
        }
        let value = HeaderValue::from_str(value).map_err(|_| invalid("Ongeldige headerwaarde."))?;
        headers.insert(name, value);
    }
    let mut request = client.request(method, url).headers(headers);
    if let Some(body) = spec.body {
        if body.len() > MAX_BODY_BYTES {
            return Err(invalid("Het verzoek is te groot."));
        }
        request = request.body(body);
    }
    if spec.bearer_from_secret {
        let Some(secret) = secrets::resolve(&spec.url)? else {
            return Err(NativeError::new(
                "missing-secret",
                "Er is geen API-sleutel opgeslagen voor dit endpoint.",
            ));
        };
        let mut value = HeaderValue::from_str(&format!("Bearer {secret}"))
            .map_err(|_| NativeError::new("secret", "De opgeslagen API-sleutel is ongeldig."))?;
        value.set_sensitive(true);
        request = request.header(reqwest::header::AUTHORIZATION, value);
    }
    Ok(request)
}

fn send_error(e: reqwest::Error, host: &str) -> HttpEvent {
    let (kind, message) = if e.is_timeout() {
        ("timeout", format!("{host} reageerde niet op tijd."))
    } else if e.is_connect() {
        (
            "network",
            format!("{host} is niet bereikbaar. Controleer de URL en je netwerkverbinding."),
        )
    } else {
        (
            "network",
            format!("Verzoek naar {host} mislukt: {}", e.without_url()),
        )
    };
    HttpEvent::Error { kind, message }
}

fn stream_error(e: reqwest::Error) -> HttpEvent {
    let kind = if e.is_timeout() { "timeout" } else { "stream" };
    HttpEvent::Error {
        kind,
        message: "De verbinding werd verbroken tijdens het antwoord.".to_string(),
    }
}

async fn run(
    request: reqwest::RequestBuilder,
    host: String,
    events: &Channel<HttpEvent>,
) -> Result<(), HttpEvent> {
    let closed = |_| HttpEvent::Error {
        kind: "aborted",
        message: "Het verzoek is gestopt.".to_string(),
    };
    let response = request.send().await.map_err(|e| send_error(e, &host))?;
    let headers = response
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|v| (k.as_str().to_string(), v.to_string()))
        })
        .collect();
    events
        .send(HttpEvent::Head {
            status: response.status().as_u16(),
            headers,
        })
        .map_err(closed)?;
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(stream_error)?;
        if !chunk.is_empty() {
            events
                .send(HttpEvent::Chunk {
                    data: chunk.to_vec(),
                })
                .map_err(closed)?;
        }
    }
    events.send(HttpEvent::End).map_err(closed)
}

pub fn start(
    http: &Http,
    id: String,
    spec: HttpRequestSpec,
    events: Channel<HttpEvent>,
) -> Result<(), NativeError> {
    let host = reqwest::Url::parse(&spec.url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    let request = build(&http.client, spec)?;
    let tasks = Arc::clone(&http.tasks);
    let mut guard = tasks
        .lock()
        .map_err(|_| NativeError::new("network", "HTTP-status is beschadigd."))?;
    let task_id = id.clone();
    let task_map = Arc::clone(&tasks);
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(event) = run(request, host, &events).await {
            let _ = events.send(event);
        }
        if let Ok(mut map) = task_map.lock() {
            map.remove(&task_id);
        }
    });
    guard.insert(id, handle);
    Ok(())
}

/// Aborts the request task; dropping it closes the connection.
pub fn cancel(http: &Http, id: &str) {
    if let Some(handle) = http.tasks.lock().ok().and_then(|mut map| map.remove(id)) {
        handle.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(url: &str, headers: Vec<(&str, &str)>) -> HttpRequestSpec {
        HttpRequestSpec {
            url: url.to_string(),
            method: "POST".to_string(),
            headers: headers
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: Some("{}".to_string()),
            bearer_from_secret: false,
        }
    }

    #[test]
    fn rejects_unsafe_requests() {
        let client = Client::new();
        assert!(build(
            &client,
            spec(
                "https://api.example.com/v1/chat/completions",
                vec![("content-type", "application/json")]
            )
        )
        .is_ok());
        assert!(build(
            &client,
            spec("http://api.example.com/v1/chat/completions", vec![])
        )
        .is_err());
        assert!(build(
            &client,
            spec(
                "https://api.example.com/v1",
                vec![("Authorization", "Bearer x")]
            )
        )
        .is_err());
        assert!(build(
            &client,
            spec("https://api.example.com/v1", vec![("cookie", "a=b")])
        )
        .is_err());
        let mut put = spec("https://api.example.com/v1", vec![]);
        put.method = "PUT".to_string();
        assert!(build(&client, put).is_err());
    }
}
