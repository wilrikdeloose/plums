use crate::canvas::{CanvasApiClient, ReadPermissions};
use crate::secrets;
use crate::storage::NativeError;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, ContentBlock,
    Implementation, ProtocolVersion, ServerCapabilities, ServerConfig,
};
use rmcp::service::{serve_client_with_lifecycle, ClientInitializeError, ClientLifecycleMode};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler, ServiceExt};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListAssignmentsParams {
    /// Het Canvas cursus-ID (moet geselecteerd zijn in de instellingen).
    pub course_id: String,
    /// Optionele Canvas bucket-filter (bijv. upcoming, future, past, unsubmitted).
    pub bucket: Option<String>,
    /// Optionele zoekterm voor opdrachttitels.
    pub search_term: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetOwnSubmissionsParams {
    /// Het Canvas cursus-ID (moet geselecteerd zijn in de instellingen).
    pub course_id: String,
    /// Optionele lijst van opdracht-ID's binnen deze cursus.
    pub assignment_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListAnnouncementsParams {
    /// Lijst van geselecteerde Canvas cursus-ID's.
    pub course_ids: Vec<String>,
    /// Optionele startdatum (YYYY-MM-DD of ISO-8601).
    pub start_date: Option<String>,
    /// Optionele einddatum (YYYY-MM-DD of ISO-8601).
    pub end_date: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListCalendarEventsParams {
    /// Lijst van geselecteerde Canvas cursus-ID's.
    pub course_ids: Vec<String>,
    /// Optionele startdatum (YYYY-MM-DD of ISO-8601).
    pub start_date: Option<String>,
    /// Optionele einddatum (YYYY-MM-DD of ISO-8601).
    pub end_date: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListModulesParams {
    /// Het Canvas cursus-ID (moet geselecteerd zijn in de instellingen).
    pub course_id: String,
    /// Optionele zoekterm voor modules of module-items.
    pub search_term: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetPageParams {
    /// Het Canvas cursus-ID (moet geselecteerd zijn in de instellingen).
    pub course_id: String,
    /// De pagina-slug (page_url) of 'front_page'.
    pub page_url_or_id: String,
}

#[derive(Clone)]
pub struct BuiltinCanvasServer {
    canvas: CanvasApiClient,
    permissions: Arc<StdMutex<ReadPermissions>>,
    tool_router: ToolRouter<Self>,
}

impl BuiltinCanvasServer {
    pub fn new(canvas: CanvasApiClient, permissions: ReadPermissions) -> Self {
        Self {
            canvas,
            permissions: Arc::new(StdMutex::new(permissions)),
            tool_router: Self::routers(),
        }
    }

    #[cfg(not(feature = "canvas-test-mode"))]
    fn routers() -> ToolRouter<Self> {
        Self::tool_router()
    }

    #[cfg(feature = "canvas-test-mode")]
    fn routers() -> ToolRouter<Self> {
        Self::tool_router() + Self::test_tool_router()
    }

    fn current_permissions(&self) -> Result<ReadPermissions, ErrorData> {
        self.permissions
            .lock()
            .map(|g| g.clone())
            .map_err(|_| ErrorData::internal_error("Toestemmingsstatus is vergrendeld.", None))
    }
}

fn json_tool_result(res: Result<Value, NativeError>) -> Result<CallToolResult, ErrorData> {
    match res {
        Ok(val) => {
            let text = serde_json::to_string(&val).unwrap_or_else(|_| "{}".to_string());
            let mut result = CallToolResult::success(vec![ContentBlock::text(text)]);
            result.structured_content = Some(val);
            Ok(result)
        }
        Err(err) => Ok(CallToolResult::error(vec![ContentBlock::text(err.message)])),
    }
}

#[tool_router]
impl BuiltinCanvasServer {
    #[tool(
        name = "canvas_list_courses",
        description = "Leest de actieve Canvas-cursussen van de ingelogde gebruiker (alleen-lezen).",
        annotations(read_only_hint = true, destructive_hint = false)
    )]
    async fn canvas_list_courses(&self) -> Result<CallToolResult, ErrorData> {
        json_tool_result(self.canvas.fetch_courses().await)
    }

    #[tool(
        name = "canvas_list_assignments",
        description = "Leest opdrachten en effectieve gebruikersspecifieke deadlines voor één geselecteerde cursus (alleen-lezen).",
        annotations(read_only_hint = true, destructive_hint = false)
    )]
    async fn canvas_list_assignments(
        &self,
        Parameters(params): Parameters<ListAssignmentsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let perms = self.current_permissions()?;
        json_tool_result(
            self.canvas
                .fetch_assignments(
                    &perms,
                    &params.course_id,
                    params.bucket.as_deref(),
                    params.search_term.as_deref(),
                )
                .await,
        )
    }

    #[tool(
        name = "canvas_get_own_submissions",
        description = "Leest uitsluitend de eigen inleverstatus van de ingelogde student voor één geselecteerde cursus (alleen-lezen).",
        annotations(read_only_hint = true, destructive_hint = false)
    )]
    async fn canvas_get_own_submissions(
        &self,
        Parameters(params): Parameters<GetOwnSubmissionsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let perms = self.current_permissions()?;
        json_tool_result(
            self.canvas
                .fetch_own_submissions(&perms, &params.course_id, params.assignment_ids.as_deref())
                .await,
        )
    }

    #[tool(
        name = "canvas_list_announcements",
        description = "Leest announcements voor geselecteerde cursussen (alleen-lezen).",
        annotations(read_only_hint = true, destructive_hint = false)
    )]
    async fn canvas_list_announcements(
        &self,
        Parameters(params): Parameters<ListAnnouncementsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let perms = self.current_permissions()?;
        json_tool_result(
            self.canvas
                .fetch_announcements(
                    &perms,
                    &params.course_ids,
                    params.start_date.as_deref(),
                    params.end_date.as_deref(),
                )
                .await,
        )
    }

    #[tool(
        name = "canvas_list_calendar_events",
        description = "Leest cursus-agenda-items (type=event) voor geselecteerde cursussen (alleen-lezen).",
        annotations(read_only_hint = true, destructive_hint = false)
    )]
    async fn canvas_list_calendar_events(
        &self,
        Parameters(params): Parameters<ListCalendarEventsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let perms = self.current_permissions()?;
        json_tool_result(
            self.canvas
                .fetch_calendar_events(
                    &perms,
                    &params.course_ids,
                    params.start_date.as_deref(),
                    params.end_date.as_deref(),
                )
                .await,
        )
    }

    #[tool(
        name = "canvas_list_modules",
        description = "Leest modules en module-items voor één geselecteerde cursus (alleen-lezen).",
        annotations(read_only_hint = true, destructive_hint = false)
    )]
    async fn canvas_list_modules(
        &self,
        Parameters(params): Parameters<ListModulesParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let perms = self.current_permissions()?;
        json_tool_result(
            self.canvas
                .fetch_modules(&perms, &params.course_id, params.search_term.as_deref())
                .await,
        )
    }

    #[tool(
        name = "canvas_get_page",
        description = "Leest de tekst van een Canvas-pagina binnen een geselecteerde cursus (alleen-lezen).",
        annotations(read_only_hint = true, destructive_hint = false)
    )]
    async fn canvas_get_page(
        &self,
        Parameters(params): Parameters<GetPageParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let perms = self.current_permissions()?;
        json_tool_result(
            self.canvas
                .fetch_page(&perms, &params.course_id, &params.page_url_or_id)
                .await,
        )
    }
}

#[cfg(feature = "canvas-test-mode")]
#[tool_router(router = test_tool_router)]
impl BuiltinCanvasServer {
    #[tool(
        name = "canvas_get_test_student_submissions",
        description = "TESTBUILD: leest de inleverstatus van de Canvas Test Student (studentweergave) van één geselecteerde, voor testen ingeschakelde cursus (alleen-lezen). De Test Student wordt server-side bepaald.",
        annotations(read_only_hint = true, destructive_hint = false)
    )]
    async fn canvas_get_test_student_submissions(
        &self,
        Parameters(params): Parameters<GetOwnSubmissionsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let perms = self.current_permissions()?;
        json_tool_result(
            self.canvas
                .fetch_test_student_submissions(&perms, &params.course_id, params.assignment_ids.as_deref())
                .await,
        )
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for BuiltinCanvasServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "plums-canvas-builtin",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(
                "PLuMS ingebouwde alleen-lezen Canvas MCP-server. Schrijfacties en niet-gecontroleerde endpoints zijn uitgeschakeld.",
            )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTargetSpec {
    pub mode: String,
    pub endpoint_url: String,
    pub permissions: ReadPermissions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAnnotationsDto {
    pub read_only_hint: Option<bool>,
    pub destructive_hint: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptorDto {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
    pub annotations: Option<ToolAnnotationsDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiscoveryDto {
    pub server_name: String,
    pub server_version: String,
    pub protocol_version: String,
    pub tools: Vec<ToolDescriptorDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallDto {
    pub is_error: bool,
    pub structured_content: Option<Value>,
    pub text_content: String,
}

fn client_config() -> ClientConfig {
    ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("plums-desktop-client", env!("CARGO_PKG_VERSION")),
    )
}

fn map_init_error(err: ClientInitializeError, endpoint: &str) -> NativeError {
    if let Some(challenge) = err.auth_challenge() {
        let lower = challenge.to_ascii_lowercase();
        if lower.contains("dpop") || lower.contains("resource_metadata") || lower.contains("authorization_uri") {
            return NativeError::new(
                "unsupported",
                format!(
                    "De externe MCP-server ({endpoint}) vereist interactieve OAuth/DPoP-authenticatie ({challenge}). PLuMS ondersteunt voor externe MCP-servers alleen een optioneel Bearer-token."
                ),
            );
        }
        return NativeError::new(
            "auth",
            format!(
                "De externe MCP-server ({endpoint}) weigerde de toegang (401/403). Controleer het optionele MCP Bearer-token in Instellingen → MCP."
            ),
        );
    }
    if err.is_authorization_required() {
        return NativeError::new(
            "auth",
            format!(
                "Authenticatie vereist door de externe MCP-server ({endpoint}). Controleer het MCP Bearer-token."
            ),
        );
    }
    match err {
        ClientInitializeError::NoCompatibleProtocolVersion {
            client_supported,
            server_supported,
        } => NativeError::new(
            "protocol",
            format!(
                "Geen compatibele MCP-protocolversie gevonden (client: {client_supported:?}, server: {server_supported:?})."
            ),
        ),
        ClientInitializeError::Cancelled => {
            NativeError::new("aborted", "De MCP-verbinding is geannuleerd.")
        }
        other => NativeError::new(
            "network",
            format!("Verbinding met MCP-server ({endpoint}) mislukt: {other}"),
        ),
    }
}

pub async fn connect_and_discover_in_process(
    canvas: CanvasApiClient,
    permissions: ReadPermissions,
) -> Result<(rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>, McpDiscoveryDto), NativeError>
{
    let server = BuiltinCanvasServer::new(canvas, permissions);
    let (client_io, server_io) = tokio::io::duplex(65_536);

    tokio::spawn(async move {
        if let Ok(running_server) = server.serve(server_io).await {
            let _ = running_server.waiting().await;
        }
    });

    let client = serve_client_with_lifecycle(
        client_config(),
        client_io,
        ClientLifecycleMode::Auto {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            legacy_version: Some(ProtocolVersion::V_2025_11_25),
        },
    )
    .await
    .map_err(|e| map_init_error(e, "ingebouwde Canvas MCP-server"))?;

    let discovery = extract_discovery(&client).await?;
    Ok((client, discovery))
}

async fn connect_remote_client(
    endpoint_url: &str,
) -> Result<rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>, NativeError> {
    // Crucially: resolve ONLY `mcp:<endpoint_url>`, NEVER the Canvas token!
    let mcp_secret_key = format!("mcp:{endpoint_url}");
    let _validated = secrets::validate_endpoint(&mcp_secret_key)?;
    let optional_token = secrets::resolve(&mcp_secret_key)?;

    let mut config = StreamableHttpClientTransportConfig::with_uri(endpoint_url.to_string())
        .control_request_timeout(Duration::from_secs(10))
        .reinit_on_expired_session(true);
    if let Some(token) = optional_token {
        config = config.auth_header(token);
    }

    let http_client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("PLuMS-MCP/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| NativeError::new("network", format!("MCP HTTP-clientfout: {e}")))?;

    let transport = StreamableHttpClientTransport::with_client(http_client, config);
    serve_client_with_lifecycle(
        client_config(),
        transport,
        ClientLifecycleMode::Auto {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            legacy_version: Some(ProtocolVersion::V_2025_11_25),
        },
    )
    .await
    .map_err(|e| map_init_error(e, endpoint_url))
}

async fn extract_discovery(
    client: &rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>,
) -> Result<McpDiscoveryDto, NativeError> {
    let (server_name, server_version, protocol_version) = match client.peer_info() {
        Some(info) => {
            let (name, version) = match &info.server_info {
                Some(si) => (si.name.clone(), si.version.clone()),
                None => ("MCP-server".to_string(), "".to_string()),
            };
            (name, version, info.protocol_version.to_string())
        }
        None => (
            "Onbekende MCP-server".to_string(),
            "".to_string(),
            "onbekend".to_string(),
        ),
    };

    let raw_tools = client.list_all_tools().await.map_err(|e| {
        NativeError::new(
            "protocol",
            format!("Fout bij het opvragen van MCP-tools (tools/list): {e}"),
        )
    })?;

    let tools = raw_tools
        .into_iter()
        .map(|t| {
            let schema_val = Value::Object((*t.input_schema).clone());
            let annotations = t.annotations.map(|a| ToolAnnotationsDto {
                read_only_hint: a.read_only_hint,
                destructive_hint: a.destructive_hint,
            });
            ToolDescriptorDto {
                name: t.name.into_owned(),
                description: t.description.map(|d| d.into_owned()),
                input_schema: schema_val,
                annotations,
            }
        })
        .collect();

    Ok(McpDiscoveryDto {
        server_name,
        server_version,
        protocol_version,
        tools,
    })
}

pub async fn execute_tool_call(
    client: &rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>,
    tool_name: String,
    args: Map<String, Value>,
) -> Result<McpToolCallDto, NativeError> {
    let params = CallToolRequestParams::new(tool_name).with_arguments(args);
    let result = client.call_tool(params).await.map_err(|e| {
        NativeError::new(
            "protocol",
            format!("MCP tool-aanroep mislukt: {e}"),
        )
    })?;

    let is_error = result.is_error.unwrap_or(false);
    let text_parts: Vec<String> = result
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect();
    let text_content = text_parts.join("\n").trim().to_string();

    Ok(McpToolCallDto {
        is_error,
        structured_content: result.structured_content,
        text_content,
    })
}

pub struct McpManager {
    tasks: Arc<StdMutex<HashMap<String, JoinHandle<()>>>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    pub fn cancel(&self, call_id: &str) {
        if let Ok(mut guard) = self.tasks.lock() {
            if let Some(handle) = guard.remove(call_id) {
                handle.abort();
            }
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(mut guard) = self.tasks.lock() {
            for (_, handle) in guard.drain() {
                handle.abort();
            }
        }
    }

    async fn run_cancellable<T, F>(&self, call_id: String, fut: F) -> Result<T, NativeError>
    where
        T: Send + 'static,
        F: std::future::Future<Output = Result<T, NativeError>> + Send + 'static,
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tasks_ref = Arc::clone(&self.tasks);
        let cid = call_id.clone();

        let handle = tauri::async_runtime::spawn(async move {
            let res = fut.await;
            let _ = tx.send(res);
            if let Ok(mut map) = tasks_ref.lock() {
                map.remove(&cid);
            }
        });

        if let Ok(mut map) = self.tasks.lock() {
            map.insert(call_id, handle);
        }

        match rx.await {
            Ok(res) => res,
            Err(_) => Err(NativeError::new(
                "aborted",
                "De MCP-bewerking is geannuleerd.",
            )),
        }
    }

    pub async fn discover(
        &self,
        call_id: String,
        target: McpTargetSpec,
    ) -> Result<McpDiscoveryDto, NativeError> {
        self.run_cancellable(call_id, async move {
            match target.mode.as_str() {
                "builtin" => {
                    let canvas = CanvasApiClient::new(&target.endpoint_url)?;
                    let (client, discovery) =
                        connect_and_discover_in_process(canvas, target.permissions).await?;
                    let _ = client.cancel().await;
                    Ok(discovery)
                }
                "remote" => {
                    let client = connect_remote_client(&target.endpoint_url).await?;
                    let discovery = extract_discovery(&client).await;
                    let _ = client.cancel().await;
                    discovery
                }
                _ => Err(NativeError::new(
                    "invalid-request",
                    "Onbekende MCP-modus.",
                )),
            }
        })
        .await
    }

    pub async fn call_tool(
        &self,
        call_id: String,
        target: McpTargetSpec,
        tool_name: String,
        args: Map<String, Value>,
    ) -> Result<McpToolCallDto, NativeError> {
        self.run_cancellable(call_id, async move {
            match target.mode.as_str() {
                "builtin" => {
                    let canvas = CanvasApiClient::new(&target.endpoint_url)?;
                    let (client, _) =
                        connect_and_discover_in_process(canvas, target.permissions).await?;
                    let res = execute_tool_call(&client, tool_name, args).await;
                    let _ = client.cancel().await;
                    res
                }
                "remote" => {
                    let client = connect_remote_client(&target.endpoint_url).await?;
                    let res = execute_tool_call(&client, tool_name, args).await;
                    let _ = client.cancel().await;
                    res
                }
                _ => Err(NativeError::new(
                    "invalid-request",
                    "Onbekende MCP-modus.",
                )),
            }
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas::CategoryPermissions;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn sample_permissions(courses: Vec<&str>, assignments: bool, submissions: bool) -> ReadPermissions {
        ReadPermissions {
            selected_course_ids: courses.into_iter().map(String::from).collect(),
            categories: CategoryPermissions {
                assignments,
                submissions,
                announcements: true,
                calendar: true,
                modules: true,
            },
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn builtin_rmcp_server_and_client_discover_and_enforce_permissions_and_pagination() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://127.0.0.1:{}", addr.port());
        let base_url_for_server = base_url.clone();

        // Spawn a lightweight mock Canvas HTTP server that verifies Bearer header, query params, and pagination
        let server_task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let base = base_url_for_server.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let first_line = req.lines().next().unwrap_or("");
                    let has_auth = req.lines().any(|l| {
                        l.to_ascii_lowercase() == "authorization: bearer test-canvas-token-secret"
                    });
                    if !has_auth {
                        let resp = "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 27\r\n\r\n{\"errors\":\"unauthorized\"}";
                        let _ = stream.write_all(resp.as_bytes()).await;
                        return;
                    }

                    if first_line.starts_with("GET /api/v1/courses?enrollment_state=active") && !first_line.contains("page=2") {
                        let body = r#"[{"id":101,"name":"Software Engineering","course_code":"SE1","workflow_state":"available"}]"#;
                        let link = format!("<{base}/api/v1/courses?enrollment_state=active&state[]=available&per_page=50&page=2>; rel=\"next\"");
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nLink: {link}\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    } else if first_line.starts_with("GET /api/v1/courses?") && first_line.contains("page=2") {
                        let body = r#"[{"id":202,"name":"AI Engineering","course_code":"AI2","workflow_state":"available"}]"#;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    } else if first_line.starts_with("GET /api/v1/courses/101 ") {
                        let body = r#"{"id":101,"name":"Software Engineering","enrollments":[{"type":"student","role":"StudentEnrollment","enrollment_state":"active"}]}"#;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    } else if first_line.starts_with("GET /api/v1/courses/202 ") {
                        let body = r#"{"id":202,"name":"AI Engineering","enrollments":[{"type":"teacher","role":"TeacherEnrollment","enrollment_state":"active"}]}"#;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    } else if first_line.starts_with("GET /api/v1/courses/101/assignments?") && first_line.contains("include%5B%5D=submission") {
                        let body = r#"[{"id":555,"course_id":101,"name":"Portfolio Opdracht","due_at":"2026-10-09T14:00:00Z","has_submitted_submissions":true,"submission":{"workflow_state":"submitted","submitted_at":"2026-10-09T10:00:00Z","late":false,"missing":false}}]"#;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    } else if first_line.starts_with("GET /api/v1/courses/101/assignments?") {
                        assert!(first_line.contains("override_assignment_dates=true"));
                        // Plain assignment reads must NEVER include `include[]=submission`
                        assert!(!first_line.contains("include"));
                        let body = r#"[{"id":555,"course_id":101,"name":"Portfolio Opdracht","description":"<p>Lever je <b>ontwerp</b> in.</p>","due_at":null,"points_possible":10.0}]"#;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    } else if first_line.starts_with("GET /api/v1/courses/101/students/submissions?") {
                        // Crucial: must never request student_ids[]
                        assert!(!first_line.contains("student_ids"));
                        let body = r#"[{"assignment_id":555,"workflow_state":"submitted","submitted_at":"2026-10-10T12:00:00Z","late":false,"missing":false}]"#;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    } else {
                        let resp = "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n[]";
                        let _ = stream.write_all(resp.as_bytes()).await;
                    }
                });
            }
        });

        let canvas = CanvasApiClient::new_for_test(&base_url, "test-canvas-token-secret");
        let perms = sample_permissions(vec!["101"], true, false);
        let (client, discovery) = connect_and_discover_in_process(canvas, perms).await.unwrap();

        assert_eq!(discovery.server_name, "plums-canvas-builtin");
        let test_tools = usize::from(cfg!(feature = "canvas-test-mode"));
        assert_eq!(discovery.tools.len(), 7 + test_tools);
        assert_eq!(
            discovery.tools.iter().any(|t| t.name == "canvas_get_test_student_submissions"),
            cfg!(feature = "canvas-test-mode")
        );

        // 1. Call `canvas_list_courses` -> follows Link rel="next" across page 1 and page 2
        let courses_res = execute_tool_call(&client, "canvas_list_courses".into(), Map::new())
            .await
            .unwrap();
        assert!(!courses_res.is_error);
        let items = courses_res
            .structured_content
            .as_ref()
            .and_then(|v| v.get("items"))
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(items.len(), 2);

        // 2. Call `canvas_list_assignments` for selected course 101 -> succeeds
        let mut args_101 = Map::new();
        args_101.insert("course_id".into(), Value::String("101".into()));
        let assign_res = execute_tool_call(&client, "canvas_list_assignments".into(), args_101.clone())
            .await
            .unwrap();
        assert!(!assign_res.is_error);

        // 3. Call `canvas_list_assignments` for unselected course 202 -> blocked by server permissions!
        let mut args_202 = Map::new();
        args_202.insert("course_id".into(), Value::String("202".into()));
        let blocked_course = execute_tool_call(&client, "canvas_list_assignments".into(), args_202)
            .await
            .unwrap();
        assert!(blocked_course.is_error);
        assert!(blocked_course.text_content.contains("niet geselecteerd"));

        // 4. Call `canvas_get_own_submissions` while `submissions` category is disabled -> blocked by server permissions!
        let blocked_cat = execute_tool_call(&client, "canvas_get_own_submissions".into(), args_101.clone())
            .await
            .unwrap();
        assert!(blocked_cat.is_error);
        assert!(blocked_cat.text_content.contains("uitgeschakeld"));

        let _ = client.cancel().await;

        // 5. Connect with `submissions: true` and courses `["101", "202"]`
        let canvas2 = CanvasApiClient::new_for_test(&base_url, "test-canvas-token-secret");
        let perms2 = sample_permissions(vec!["101", "202"], true, true);
        let (client2, _) = connect_and_discover_in_process(canvas2, perms2).await.unwrap();

        // Course 101 (StudentEnrollment): returns own submission via authorized `assignments?include[]=submission`
        let sub_101 = execute_tool_call(&client2, "canvas_get_own_submissions".into(), args_101)
            .await
            .unwrap();
        assert!(!sub_101.is_error);
        let sc_101 = sub_101.structured_content.unwrap();
        assert_eq!(sc_101.get("enrollmentStatus").and_then(Value::as_str), Some("student"));
        let sub_items = sc_101.get("items").and_then(Value::as_array).unwrap();
        assert_eq!(sub_items.len(), 1);
        assert_eq!(sub_items[0].get("assignment_id").and_then(Value::as_str), Some("555"));
        assert_eq!(sub_items[0].get("workflow_state").and_then(Value::as_str), Some("submitted"));

        // Course 202 (TeacherEnrollment): returns `not_applicable_non_student` without hitting 403 on `students/submissions`
        let mut args_202_sub = Map::new();
        args_202_sub.insert("course_id".into(), Value::String("202".into()));
        let sub_202 = execute_tool_call(&client2, "canvas_get_own_submissions".into(), args_202_sub)
            .await
            .unwrap();
        assert!(!sub_202.is_error);
        let sc_202 = sub_202.structured_content.unwrap();
        assert_eq!(
            sc_202.get("enrollmentStatus").and_then(Value::as_str),
            Some("not_applicable_non_student")
        );

        let _ = client2.cancel().await;
        server_task.abort();
    }

    #[tokio::test]
    #[ignore = "live Canvas + AI check using configured OS keyring credentials"]
    async fn live_builtin_canvas_and_ai_round_trip() {
        let canvas_url = "https://fhict.instructure.com";
        let ai_url = "https://api.portkey.ai/v1/chat/completions";
        let ai_model = "fontys-mistral-large-3";
        let selected_course_id = "16040";

        let canvas = CanvasApiClient::new(canvas_url).expect("Canvas token in OS keyring");
        let perms = ReadPermissions {
            selected_course_ids: vec![selected_course_id.to_string(), "15685".to_string()],
            categories: CategoryPermissions {
                assignments: true,
                submissions: true,
                announcements: true,
                calendar: true,
                modules: true,
            },
            ..Default::default()
        };

        let (client, discovery) = connect_and_discover_in_process(canvas, perms)
            .await
            .expect("Built-in MCP discovery");
        println!(
            "[LIVE BUILTIN MCP] Server: {} {}, Tools: {}",
            discovery.server_name,
            discovery.server_version,
            discovery.tools.len()
        );

        let mut args = Map::new();
        args.insert("course_id".into(), Value::String(selected_course_id.into()));

        // Course 16040: user is enrolled as TeacherEnrollment (non-student), so own submissions must return
        // `enrollmentStatus == "not_applicable_non_student"` (not an HTTP 403 error, and not unsubmitted!)
        let sub_res = execute_tool_call(&client, "canvas_get_own_submissions".into(), args.clone())
            .await
            .expect("canvas_get_own_submissions on 16040");
        assert!(!sub_res.is_error, "expected non-error not_applicable result: {}", sub_res.text_content);
        let sub_status_16040 = sub_res
            .structured_content
            .as_ref()
            .and_then(|v| v.get("enrollmentStatus"))
            .and_then(Value::as_str);
        assert_eq!(sub_status_16040, Some("not_applicable_non_student"));

        // Course 15685: user is enrolled as StudentEnrollment, so own submissions must return actual own submission records
        let mut student_args = Map::new();
        student_args.insert("course_id".into(), Value::String("15685".into()));
        let student_sub_res = execute_tool_call(&client, "canvas_get_own_submissions".into(), student_args)
            .await
            .expect("canvas_get_own_submissions on 15685");
        assert!(!student_sub_res.is_error, "expected student submission result: {}", student_sub_res.text_content);
        let sub_status_15685 = student_sub_res
            .structured_content
            .as_ref()
            .and_then(|v| v.get("enrollmentStatus"))
            .and_then(Value::as_str);
        assert_eq!(sub_status_15685, Some("student"));

        let assign_res = execute_tool_call(&client, "canvas_list_assignments".into(), args.clone())
            .await
            .expect("canvas_list_assignments");
        assert!(!assign_res.is_error, "assignments error: {}", assign_res.text_content);
        println!(
            "[LIVE CANVAS ASSIGNMENTS] Retrieved payload length: {} chars",
            assign_res.text_content.len()
        );

        let mut ann_args = Map::new();
        ann_args.insert(
            "course_ids".into(),
            Value::Array(vec![Value::String(selected_course_id.into())]),
        );
        let ann_res = execute_tool_call(&client, "canvas_list_announcements".into(), ann_args)
            .await
            .expect("canvas_list_announcements");
        assert!(!ann_res.is_error, "announcements error: {}", ann_res.text_content);
        println!(
            "[LIVE CANVAS ANNOUNCEMENTS] Retrieved payload length: {} chars",
            ann_res.text_content.len()
        );

        // Verify AI function calling with the live configured AI endpoint if key is present in keyring
        if let Ok(Some(ai_key)) = crate::secrets::resolve(ai_url) {
            let http = reqwest::Client::new();
            let tool_spec = serde_json::json!([{
                "type": "function",
                "function": {
                    "name": "canvas_list_assignments",
                    "description": "Haal opdrachten en deadlines op voor een geselecteerde Canvas-cursus (alleen-lezen).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "course_id": { "type": "string" }
                        },
                        "required": ["course_id"],
                        "additionalProperties": false
                    }
                }
            }]);

            let req1 = serde_json::json!({
                "model": ai_model,
                "stream": false,
                "tools": tool_spec,
                "tool_choice": "auto",
                "messages": [
                    {
                        "role": "system",
                        "content": format!("Je bent PLuMS. Geselecteerde Canvas-cursus: course_id \"{selected_course_id}\". Gebruik canvas_list_assignments om deadlines op te halen.")
                    },
                    {
                        "role": "user",
                        "content": "Welke opdrachten en deadlines staan er in mijn geselecteerde cursus?"
                    }
                ]
            });

            let resp1 = http
                .post(ai_url)
                .bearer_auth(&ai_key)
                .json(&req1)
                .send()
                .await
                .expect("AI request 1");
            let status1 = resp1.status();
            let body1: Value = resp1.json().await.expect("AI JSON 1");
            println!("[LIVE AI ROUND 1] HTTP {status1}");
            assert!(status1.is_success(), "AI HTTP status: {status1} {body1}");

            let tool_calls = body1
                .pointer("/choices/0/message/tool_calls")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            println!("[LIVE AI ROUND 1 TOOL CALLS] count={}", tool_calls.len());
            assert!(!tool_calls.is_empty(), "Expected model to emit tool_calls: {body1}");

            let first_call = &tool_calls[0];
            let call_id = first_call.get("id").and_then(Value::as_str).unwrap_or("call_1");
            let fn_name = first_call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            assert_eq!(fn_name, "canvas_list_assignments");

            // Bound the assignment payload for round 2 just like shared TypeScript `formatBoundedToolPayload`
            let bounded_payload: String = assign_res.text_content.chars().take(6000).collect();

            let req2 = serde_json::json!({
                "model": ai_model,
                "stream": false,
                "messages": [
                    {
                        "role": "system",
                        "content": format!("Je bent PLuMS. Antwoord in het Nederlands met een Markdown-tabel en bronlinks uit het toolresultaat.")
                    },
                    {
                        "role": "user",
                        "content": "Welke opdrachten en deadlines staan er in mijn geselecteerde cursus?"
                    },
                    body1.pointer("/choices/0/message").cloned().unwrap(),
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": format!("<canvas_gegevens>\n{bounded_payload}\n</canvas_gegevens>")
                    }
                ]
            });

            let resp2 = http
                .post(ai_url)
                .bearer_auth(&ai_key)
                .json(&req2)
                .send()
                .await
                .expect("AI request 2");
            let status2 = resp2.status();
            let body2: Value = resp2.json().await.expect("AI JSON 2");
            let answer = body2
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .unwrap_or("");
            println!("[LIVE AI ROUND 2] HTTP {status2}, answer length={} chars", answer.len());
            assert!(status2.is_success(), "AI round 2 HTTP status: {status2}");
            assert!(!answer.trim().is_empty(), "Expected non-empty Dutch answer");
        }

        let _ = client.cancel().await;
    }
}
