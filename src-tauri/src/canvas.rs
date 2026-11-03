use crate::secrets;
use crate::storage::NativeError;
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, LINK};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_PAGES: usize = 5;
const PER_PAGE: &str = "50";
const MAX_TOTAL_ITEMS: usize = 250;
const MAX_MODULES_TO_EXPAND: usize = 20;

type UrlValidator<'a> = dyn Fn(&Url, &Url) -> Result<(), NativeError> + Sync + 'a;

#[cfg(feature = "canvas-test-mode")]
pub mod test_student;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryPermissions {
    pub assignments: bool,
    pub submissions: bool,
    pub announcements: bool,
    pub calendar: bool,
    pub modules: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPermissions {
    pub selected_course_ids: Vec<String>,
    pub categories: CategoryPermissions,
    /// Courses for which the Canvas Test Student may be read. Without the feature this field does not
    /// exist, so a value sent by any frontend is ignored during deserialization.
    #[cfg(feature = "canvas-test-mode")]
    #[serde(default)]
    pub test_student_course_ids: Vec<String>,
}

impl ReadPermissions {
    pub fn check_course(&self, course_id: &str) -> Result<String, NativeError> {
        let trimmed = course_id.trim();
        if !is_safe_id(trimmed) {
            return Err(NativeError::new("permission", "Ongeldig cursus-ID."));
        }
        if !self.selected_course_ids.iter().any(|c| c == trimmed) {
            return Err(NativeError::new(
                "permission",
                format!(
                    "Cursus {trimmed} is niet geselecteerd in Instellingen → Canvas en mag niet worden gelezen."
                ),
            ));
        }
        Ok(trimmed.to_string())
    }

    pub fn check_courses(&self, course_ids: &[String]) -> Result<Vec<String>, NativeError> {
        if course_ids.is_empty() {
            return Err(NativeError::new(
                "permission",
                "Geef ten minste één geselecteerde cursus op.",
            ));
        }
        let mut out = Vec::new();
        for id in course_ids {
            let checked = self.check_course(id)?;
            if !out.contains(&checked) {
                out.push(checked);
            }
        }
        out.truncate(10);
        Ok(out)
    }
}

pub fn is_safe_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn is_safe_page_locator(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && !s.contains("..")
        && !s.contains('/')
        && !s.contains('\\')
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'_' | b'-' | b'.' | b':' | b'%')
        })
}

fn now_iso_approx() -> String {
    // Format current UTC timestamp as ISO-8601 (YYYY-MM-DDTHH:MM:SSZ)
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

/// Checks origin, URL credentials and the `/api/v1/` prefix; returns the path segments after `/api/v1/`.
fn api_v1_tail<'a>(base_origin: &Url, target: &'a Url) -> Result<Vec<&'a str>, NativeError> {
    if target.scheme() != base_origin.scheme()
        || target.host_str() != base_origin.host_str()
        || target.port_or_known_default() != base_origin.port_or_known_default()
    {
        return Err(NativeError::new(
            "permission",
            "Geweigerd: het Canvas-verzoek wijkt af van het ingestelde Canvas-domein (origin mismatch).",
        ));
    }
    if !target.username().is_empty() || target.password().is_some() {
        return Err(NativeError::new(
            "permission",
            "Inloggegevens in de URL zijn niet toegestaan.",
        ));
    }

    let base_prefix = base_origin.path().trim_end_matches('/');
    let rel_path = target
        .path()
        .strip_prefix(base_prefix)
        .unwrap_or(target.path());

    let segments: Vec<&str> = rel_path
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    if segments.len() < 3 || segments[0] != "api" || segments[1] != "v1" {
        return Err(NativeError::new(
            "permission",
            format!("Geweigerd: pad '{}' valt buiten /api/v1/.", target.path()),
        ));
    }
    Ok(segments[2..].to_vec())
}

/// Validates that a URL is a strictly read-only, reviewed Canvas REST API GET endpoint on the exact configured origin.
/// This check runs on every initial request AND on every `Link: rel="next"` pagination URL before attaching the token.
pub fn validate_canvas_get_url(base_origin: &Url, target: &Url) -> Result<(), NativeError> {
    let segments = api_v1_tail(base_origin, target)?;
    let tail = segments.as_slice();
    let allowed_query_keys: &[&str] = match tail {
        // 1. Courses: GET /api/v1/courses and GET /api/v1/courses/:course_id
        ["courses"] => &["enrollment_state", "state[]", "per_page", "page"],
        ["courses", course_id] if is_safe_id(course_id) => &[],

        // 2. Assignments: GET /api/v1/courses/:course_id/assignments
        // Note: `include[]` is permitted ONLY with value `submission` (checked below) when the
        // `submissions` read tool is invoked, never on plain `assignments` reads!
        ["courses", course_id, "assignments"] if is_safe_id(course_id) => &[
            "override_assignment_dates",
            "order_by",
            "bucket",
            "search_term",
            "include[]",
            "per_page",
            "page",
        ],

        // 3a. Own submissions (bulk): GET /api/v1/courses/:course_id/students/submissions
        // Note: `student_ids[]` is deliberately omitted from allowed_query_keys so Canvas only returns the calling student's own submissions!
        ["courses", course_id, "students", "submissions"] if is_safe_id(course_id) => {
            &["assignment_ids[]", "workflow_state", "per_page", "page"]
        }

        // 3b. Own submission (single): GET /api/v1/courses/:course_id/assignments/:assignment_id/submissions/self
        ["courses", course_id, "assignments", assignment_id, "submissions", "self"]
            if is_safe_id(course_id) && is_safe_id(assignment_id) =>
        {
            &[]
        }

        // 4. Announcements: GET /api/v1/announcements
        ["announcements"] => &[
            "context_codes[]",
            "start_date",
            "end_date",
            "active_only",
            "per_page",
            "page",
        ],

        // 5. Calendar events: GET /api/v1/calendar_events
        ["calendar_events"] => &[
            "type",
            "context_codes[]",
            "start_date",
            "end_date",
            "all_events",
            "per_page",
            "page",
        ],

        // 6. Modules & module items:
        // GET /api/v1/courses/:course_id/modules
        // GET /api/v1/courses/:course_id/modules/:module_id/items
        ["courses", course_id, "modules"] if is_safe_id(course_id) => {
            &["search_term", "per_page", "page"]
        }
        ["courses", course_id, "modules", module_id, "items"]
            if is_safe_id(course_id) && is_safe_id(module_id) =>
        {
            &["search_term", "per_page", "page"]
        }

        // 7. Pages:
        // GET /api/v1/courses/:course_id/pages/:url_or_id
        // GET /api/v1/courses/:course_id/front_page
        ["courses", course_id, "pages", page_slug]
            if is_safe_id(course_id) && is_safe_page_locator(page_slug) =>
        {
            &[]
        }
        ["courses", course_id, "front_page"] if is_safe_id(course_id) => &[],

        _ => {
            return Err(NativeError::new(
                "permission",
                format!(
                    "Geweigerd: Canvas-endpoint '{}' staat niet op de gecontroleerde alleen-lezen lijst.",
                    target.path()
                ),
            ))
        }
    };

    let is_calendar = tail == ["calendar_events"];
    let mut saw_calendar_type_event = false;

    for (key, value) in target.query_pairs() {
        let k = key.as_ref();
        let v = value.as_ref();

        // Strictly forbid any `student_id`, `user_id`, `as_user_id`, or unapproved `include` parameter across all endpoints
        if k.eq_ignore_ascii_case("include")
            || k.to_ascii_lowercase().contains("student_id")
            || k.eq_ignore_ascii_case("user_id")
            || k.eq_ignore_ascii_case("as_user_id")
        {
            return Err(NativeError::new(
                "permission",
                format!("Geweigerd: queryparameter '{k}' is niet toegestaan."),
            ));
        }

        if k.eq_ignore_ascii_case("include[]") {
            let is_assignments = matches!(tail, ["courses", cid, "assignments"] if is_safe_id(cid));
            if !is_assignments || v != "submission" {
                return Err(NativeError::new(
                    "permission",
                    format!("Geweigerd: include[]='{v}' is niet toegestaan (alleen include[]=submission op opdrachten voor eigen inleverstatus)."),
                ));
            }
        }

        if !allowed_query_keys.contains(&k) {
            return Err(NativeError::new(
                "permission",
                format!("Geweigerd: queryparameter '{k}' is niet toegestaan op dit endpoint."),
            ));
        }

        if k == "context_codes[]" {
            let Some(course_id) = v.strip_prefix("course_") else {
                return Err(NativeError::new(
                    "permission",
                    "Geweigerd: context_codes[] mag alleen 'course_<id>' bevatten.",
                ));
            };
            if !is_safe_id(course_id) {
                return Err(NativeError::new(
                    "permission",
                    "Geweigerd: ongeldige cursus-ID in context_codes[].",
                ));
            }
        }

        if is_calendar && k == "type" {
            if v != "event" {
                return Err(NativeError::new(
                    "permission",
                    "Geweigerd: calendar_events ondersteunt alleen type=event (opdrachten worden nooit via de agenda opgehaald).",
                ));
            }
            saw_calendar_type_event = true;
        }
    }

    if is_calendar && !saw_calendar_type_event {
        return Err(NativeError::new(
            "permission",
            "Geweigerd: calendar_events vereist expliciet type=event.",
        ));
    }

    Ok(())
}

/// Extracts the `rel="next"` URL from an RFC 5988 `Link` HTTP header.
pub fn parse_next_link(link_header: &str) -> Option<String> {
    for part in link_header.split(',') {
        let mut segments = part.split(';');
        let raw_url = segments.next()?.trim();
        if !raw_url.starts_with('<') || !raw_url.ends_with('>') {
            continue;
        }
        let url = &raw_url[1..raw_url.len() - 1];
        for param in segments {
            let p = param.trim();
            if p.eq_ignore_ascii_case("rel=\"next\"") || p.eq_ignore_ascii_case("rel=next") {
                return Some(url.to_string());
            }
        }
    }
    None
}

#[derive(Clone)]
pub struct CanvasApiClient {
    http: Client,
    base_url: Url,
    secret_key: String,
    test_token_override: Option<String>,
}

impl CanvasApiClient {
    pub fn new(normalized_base_url: &str) -> Result<Self, NativeError> {
        let secret_key = format!("canvas:{normalized_base_url}");
        let base_url = secrets::validate_endpoint(&secret_key)?;
        if base_url.query().is_some() {
            return Err(NativeError::new(
                "invalid-request",
                "De Canvas basis-URL mag geen queryparameters bevatten.",
            ));
        }
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("PLuMS-Canvas-MCP/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| NativeError::new("network", format!("HTTP-clientfout: {e}")))?;

        Ok(Self {
            http,
            base_url,
            secret_key,
            test_token_override: None,
        })
    }

    #[cfg(test)]
    pub fn new_for_test(base_url: &str, token: &str) -> Self {
        let parsed = Url::parse(base_url).expect("valid test base url");
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        Self {
            http,
            base_url: parsed,
            secret_key: format!("canvas:{base_url}"),
            test_token_override: Some(token.to_string()),
        }
    }

    fn resolve_token(&self) -> Result<String, NativeError> {
        if let Some(token) = &self.test_token_override {
            return Ok(token.clone());
        }
        secrets::resolve(&self.secret_key)?.ok_or_else(|| {
            NativeError::new(
                "missing-secret",
                "Er is geen Canvas-toegangstoken opgeslagen voor deze Canvas-URL.",
            )
        })
    }

    fn build_api_url(&self, api_path: &str, query: &[(&str, &str)]) -> Result<Url, NativeError> {
        self.build_api_url_with(api_path, query, &validate_canvas_get_url)
    }

    fn build_api_url_with(
        &self,
        api_path: &str,
        query: &[(&str, &str)],
        validator: &UrlValidator<'_>,
    ) -> Result<Url, NativeError> {
        let base_str = self.base_url.as_str().trim_end_matches('/');
        let path_str = api_path.trim_start_matches('/');
        let mut url = Url::parse(&format!("{base_str}/{path_str}"))
            .map_err(|_| NativeError::new("invalid-request", "Ongeldige Canvas API-URL."))?;
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (k, v) in query {
                pairs.append_pair(k, v);
            }
        }
        validator(&self.base_url, &url)?;
        Ok(url)
    }

    async fn get_single_page(&self, url: &Url, token: &str) -> Result<(Value, Option<String>), NativeError> {
        self.get_single_page_with(url, token, &validate_canvas_get_url).await
    }

    async fn get_single_page_with(
        &self,
        url: &Url,
        token: &str,
        validator: &UrlValidator<'_>,
    ) -> Result<(Value, Option<String>), NativeError> {
        validator(&self.base_url, url)?;

        let mut auth_val = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| NativeError::new("secret", "Het opgeslagen Canvas-token heeft een ongeldig formaat."))?;
        auth_val.set_sensitive(true);

        let response = self
            .http
            .request(Method::GET, url.clone())
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, auth_val)
            .send()
            .await
            .map_err(|e| {
                let host = url.host_str().unwrap_or("Canvas");
                if e.is_timeout() {
                    NativeError::new("timeout", format!("{host} reageerde niet op tijd."))
                } else {
                    NativeError::new(
                        "network",
                        format!("Kan geen verbinding maken met {host}: {}", e.without_url()),
                    )
                }
            })?;

        let status = response.status();
        let req_path = url.path().to_string();
        if status.is_redirection() {
            return Err(NativeError::new(
                "permission",
                format!("Canvas probeerde door te verwijzen op GET {req_path} (redirect). Om je token te beschermen volgt PLuMS geen redirects."),
            ));
        }
        if status == StatusCode::UNAUTHORIZED {
            return Err(NativeError::new(
                "auth",
                format!("Canvas weigerde het toegangstoken op GET {req_path} (HTTP 401). Controleer of het token geldig en niet verlopen is."),
            ));
        }
        if status == StatusCode::FORBIDDEN {
            return Err(NativeError::new(
                "forbidden",
                format!("Geen toegang tot dit Canvas-onderdeel op GET {req_path} (HTTP 403). Mogelijk heeft dit account geen rechten of geen student-inschrijving voor dit onderdeel."),
            ));
        }
        if status == StatusCode::NOT_FOUND {
            return Err(NativeError::new(
                "not-found",
                format!("Het gevraagde Canvas-onderdeel op GET {req_path} is niet gevonden (HTTP 404)."),
            ));
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(NativeError::new(
                "rate-limit",
                format!("Canvas rate-limit bereikt op GET {req_path} (HTTP 429). Wacht even en probeer het opnieuw."),
            ));
        }
        if !status.is_success() {
            return Err(NativeError::new(
                "network",
                format!("Canvas gaf een foutmelding op GET {req_path} (HTTP {}).", status.as_u16()),
            ));
        }

        let next_link = response
            .headers()
            .get_all(LINK)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .find_map(parse_next_link);

        let body: Value = response.json().await.map_err(|_| {
            NativeError::new(
                "protocol",
                "Canvas stuurde een antwoord dat geen geldige JSON is.",
            )
        })?;

        Ok((body, next_link))
    }

    async fn get_paginated_list(
        &self,
        api_path: &str,
        query: &[(&str, &str)],
    ) -> Result<(Vec<Value>, bool, Vec<String>), NativeError> {
        self.get_paginated_list_with(api_path, query, &validate_canvas_get_url).await
    }

    async fn get_paginated_list_with(
        &self,
        api_path: &str,
        query: &[(&str, &str)],
        validator: &UrlValidator<'_>,
    ) -> Result<(Vec<Value>, bool, Vec<String>), NativeError> {
        let token = self.resolve_token()?;
        let mut current_url = self.build_api_url_with(api_path, query, validator)?;
        let mut items = Vec::new();
        let mut warnings = Vec::new();
        let mut truncated = false;

        for page_idx in 0..MAX_PAGES {
            let (body, next_link) = match self.get_single_page_with(&current_url, &token, validator).await {
                Ok(res) => res,
                Err(err) if page_idx > 0 => {
                    truncated = true;
                    warnings.push(format!(
                        "Vervolgpagina {} kon niet worden geladen: {}",
                        page_idx + 1,
                        err.message
                    ));
                    break;
                }
                Err(err) => return Err(err),
            };

            let Some(page_items) = body.as_array() else {
                return Err(NativeError::new(
                    "protocol",
                    "Canvas stuurde geen lijst terug op een lijst-endpoint.",
                ));
            };

            for item in page_items {
                if items.len() >= MAX_TOTAL_ITEMS {
                    truncated = true;
                    warnings.push(format!(
                        "Resultaten begrensd op maximaal {MAX_TOTAL_ITEMS} items."
                    ));
                    break;
                }
                items.push(item.clone());
            }

            if items.len() >= MAX_TOTAL_ITEMS {
                break;
            }

            let Some(next_raw) = next_link else {
                break;
            };

            if page_idx + 1 >= MAX_PAGES {
                truncated = true;
                warnings.push(format!(
                    "Paginering begrensd na {MAX_PAGES} pagina's; niet alle Canvas-items zijn opgehaald."
                ));
                break;
            }

            let next_url = Url::parse(&next_raw).or_else(|_| self.base_url.join(&next_raw)).map_err(|_| {
                NativeError::new("permission", "Ongeldige vervolg-URL in Canvas Link-header.")
            })?;

            // Re-validate origin & allowlist on the Link rel="next" URL before following it!
            if let Err(err) = validator(&self.base_url, &next_url) {
                truncated = true;
                warnings.push(format!(
                    "Vervolgpagina overgeslagen wegens beveiligingsbeleid: {}",
                    err.message
                ));
                break;
            }
            current_url = next_url;
        }

        Ok((items, truncated, warnings))
    }

    pub async fn fetch_courses(&self) -> Result<Value, NativeError> {
        let (items, truncated, warnings) = self
            .get_paginated_list(
                "/api/v1/courses",
                &[
                    ("enrollment_state", "active"),
                    ("state[]", "available"),
                    ("per_page", PER_PAGE),
                ],
            )
            .await?;
        Ok(json!({
            "items": items,
            "truncated": truncated,
            "warnings": warnings,
            "retrievedAt": now_iso_approx(),
        }))
    }

    pub async fn fetch_assignments(
        &self,
        permissions: &ReadPermissions,
        course_id: &str,
        bucket: Option<&str>,
        search_term: Option<&str>,
    ) -> Result<Value, NativeError> {
        if !permissions.categories.assignments {
            return Err(NativeError::new(
                "permission",
                "De categorie 'Opdrachten en deadlines' is uitgeschakeld.",
            ));
        }
        let cid = permissions.check_course(course_id)?;
        let mut query: Vec<(&str, &str)> = vec![
            ("override_assignment_dates", "true"),
            ("order_by", "due_at"),
            ("per_page", PER_PAGE),
        ];
        if let Some(b) = bucket.map(str::trim).filter(|s| !s.is_empty()) {
            query.push(("bucket", b));
        }
        if let Some(st) = search_term.map(str::trim).filter(|s| !s.is_empty()) {
            query.push(("search_term", st));
        }
        let path = format!("/api/v1/courses/{cid}/assignments");
        let (items, truncated, warnings) = self.get_paginated_list(&path, &query).await?;
        Ok(json!({
            "items": items,
            "truncated": truncated,
            "warnings": warnings,
            "retrievedAt": now_iso_approx(),
        }))
    }

    pub async fn fetch_own_submissions(
        &self,
        permissions: &ReadPermissions,
        course_id: &str,
        assignment_ids: Option<&[String]>,
    ) -> Result<Value, NativeError> {
        if !permissions.categories.submissions {
            return Err(NativeError::new(
                "permission",
                "De categorie 'Eigen inleverstatus' is uitgeschakeld.",
            ));
        }
        let cid = permissions.check_course(course_id)?;
        let filter_ids: Option<Vec<String>> = match assignment_ids {
            Some(a_ids) if !a_ids.is_empty() => {
                let mut valid = Vec::new();
                for aid in a_ids.iter().take(50) {
                    let trimmed = aid.trim();
                    if !is_safe_id(trimmed) {
                        return Err(NativeError::new("permission", "Ongeldig opdracht-ID."));
                    }
                    valid.push(trimmed.to_string());
                }
                Some(valid)
            }
            _ => None,
        };

        // Check the authenticated user's enrollment role in this course via `GET /api/v1/courses/:id`.
        // In Canvas, `GET /api/v1/courses/:id/students/submissions` defaults to `student_ids[]=self`,
        // which returns HTTP 403 Forbidden when a teacher/TA/designer/observer account is not enrolled
        // as a student in the course. Checking enrollments first prevents false 403 errors and avoids
        // claiming non-student enrollments have "unsubmitted" work.
        let token = self.resolve_token()?;
        let course_path = format!("/api/v1/courses/{cid}");
        if let Ok(course_url) = self.build_api_url(&course_path, &[]) {
            if let Ok((course_obj, _)) = self.get_single_page(&course_url, &token).await {
                if let Some(enrollments) = course_obj.get("enrollments").and_then(Value::as_array) {
                    if !enrollments.is_empty() {
                        let has_student = enrollments.iter().any(|e| {
                            let etype = e
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_ascii_lowercase();
                            let erole = e
                                .get("role")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_ascii_lowercase();
                            etype == "student"
                                || etype == "studentenrollment"
                                || erole == "studentenrollment"
                        });
                        if !has_student {
                            let roles: Vec<String> = enrollments
                                .iter()
                                .filter_map(|e| {
                                    e.get("role")
                                        .or_else(|| e.get("type"))
                                        .and_then(Value::as_str)
                                        .map(String::from)
                                })
                                .collect();
                            let role_label = if roles.is_empty() {
                                "geen studentrol".to_string()
                            } else {
                                roles.join(", ")
                            };
                            return Ok(json!({
                                "items": [],
                                "enrollmentStatus": "not_applicable_non_student",
                                "enrollmentRoles": roles,
                                "truncated": false,
                                "warnings": [
                                    format!(
                                        "Het gekoppelde Canvas-account is in cursus {cid} ingeschreven als '{role_label}' (geen StudentEnrollment). Eigen inleverstatus is daarom niet van toepassing (status: niet van toepassing / onbekend, NIET 'niet ingeleverd')."
                                    )
                                ],
                                "retrievedAt": now_iso_approx(),
                            }));
                        }
                    }
                }
            }
        }

        // Authorized own-user read: `GET /api/v1/courses/:course_id/assignments?override_assignment_dates=true&include[]=submission`
        // Per Canvas API docs, `include[]=submission` returns ONLY the current authenticated user's own
        // submission object embedded in each assignment (never other students' submissions).
        let assign_path = format!("/api/v1/courses/{cid}/assignments");
        let assign_query = [
            ("override_assignment_dates", "true"),
            ("order_by", "due_at"),
            ("include[]", "submission"),
            ("per_page", PER_PAGE),
        ];

        match self.get_paginated_list(&assign_path, &assign_query).await {
            Ok((assignments, truncated, mut warnings)) => {
                let mut submission_items = Vec::new();
                let mut saw_any_submission_obj = false;

                for assign in assignments {
                    let Some(obj) = assign.as_object() else {
                        continue;
                    };
                    let aid = match obj.get("id") {
                        Some(Value::Number(n)) => n.to_string(),
                        Some(Value::String(s)) => s.clone(),
                        _ => continue,
                    };
                    if let Some(ref allowed) = filter_ids {
                        if !allowed.iter().any(|x| x == &aid) {
                            continue;
                        }
                    }
                    let title = obj
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("Opdracht")
                        .to_string();
                    let due_at = obj.get("due_at").cloned().unwrap_or(Value::Null);
                    let html_url = obj.get("html_url").cloned().unwrap_or(Value::Null);

                    // Important: ignore `has_submitted_submissions` (which is course-wide) and inspect ONLY `submission`
                    match obj.get("submission") {
                        Some(Value::Object(sub)) => {
                            saw_any_submission_obj = true;
                            let mut merged = sub.clone();
                            merged.insert("assignment_id".into(), Value::String(aid));
                            merged.insert("course_id".into(), Value::String(cid.clone()));
                            merged.insert("assignment_name".into(), Value::String(title));
                            merged.insert("due_at".into(), due_at);
                            if !merged.contains_key("html_url") {
                                merged.insert("html_url".into(), html_url);
                            }
                            submission_items.push(Value::Object(merged));
                        }
                        _ => {
                            // `submission` is null or omitted (e.g. non-student role or unavailable):
                            // record as `unknown` / `not_applicable`, NEVER as `unsubmitted`!
                            submission_items.push(json!({
                                "assignment_id": aid,
                                "course_id": cid,
                                "assignment_name": title,
                                "due_at": due_at,
                                "html_url": html_url,
                                "workflow_state": "unknown",
                                "submitted_at": null,
                            }));
                        }
                    }
                }

                if !saw_any_submission_obj && !submission_items.is_empty() {
                    warnings.push(format!(
                        "Canvas gaf bij GET {assign_path}?include[]=submission geen persoonlijk 'submission'-object terug voor cursus {cid}. Mogelijk heeft dit account geen student-inschrijving in deze cursus; de inleverstatus is daarom onbekend/niet van toepassing."
                    ));
                }

                return Ok(json!({
                    "items": submission_items,
                    "enrollmentStatus": if saw_any_submission_obj { "student" } else { "unknown_or_non_student" },
                    "truncated": truncated,
                    "warnings": warnings,
                    "retrievedAt": now_iso_approx(),
                }));
            }
            Err(primary_err) => {
                // Fallback to `GET /api/v1/courses/:course_id/students/submissions` (own user only, no `student_ids[]`)
                let mut query_owned: Vec<(String, String)> =
                    vec![("per_page".into(), PER_PAGE.into())];
                if let Some(ref allowed) = filter_ids {
                    for aid in allowed.iter().take(25) {
                        query_owned.push(("assignment_ids[]".into(), aid.clone()));
                    }
                }
                let query_refs: Vec<(&str, &str)> = query_owned
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.as_str()))
                    .collect();
                let sub_path = format!("/api/v1/courses/{cid}/students/submissions");
                match self.get_paginated_list(&sub_path, &query_refs).await {
                    Ok((items, truncated, warnings)) => Ok(json!({
                        "items": items,
                        "enrollmentStatus": "student",
                        "truncated": truncated,
                        "warnings": warnings,
                        "retrievedAt": now_iso_approx(),
                    })),
                    Err(fallback_err) => Err(NativeError::new(
                        fallback_err.kind,
                        format!(
                            "{} (primair endpoint: {})",
                            fallback_err.message, primary_err.message
                        ),
                    )),
                }
            }
        }
    }

    pub async fn fetch_announcements(
        &self,
        permissions: &ReadPermissions,
        course_ids: &[String],
        start_date: Option<&str>,
        end_date: Option<&str>,
    ) -> Result<Value, NativeError> {
        if !permissions.categories.announcements {
            return Err(NativeError::new(
                "permission",
                "De categorie 'Announcements' is uitgeschakeld.",
            ));
        }
        let checked_courses = permissions.check_courses(course_ids)?;
        let mut query_owned: Vec<(String, String)> = checked_courses
            .iter()
            .map(|id| ("context_codes[]".to_string(), format!("course_{id}")))
            .collect();
        query_owned.push(("active_only".into(), "true".into()));
        query_owned.push(("per_page".into(), PER_PAGE.into()));
        if let Some(sd) = start_date.map(str::trim).filter(|s| !s.is_empty()) {
            query_owned.push(("start_date".into(), sd.to_string()));
        }
        if let Some(ed) = end_date.map(str::trim).filter(|s| !s.is_empty()) {
            query_owned.push(("end_date".into(), ed.to_string()));
        }
        let query_refs: Vec<(&str, &str)> = query_owned
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let (items, truncated, warnings) = self
            .get_paginated_list("/api/v1/announcements", &query_refs)
            .await?;
        Ok(json!({
            "items": items,
            "truncated": truncated,
            "warnings": warnings,
            "retrievedAt": now_iso_approx(),
        }))
    }

    pub async fn fetch_calendar_events(
        &self,
        permissions: &ReadPermissions,
        course_ids: &[String],
        start_date: Option<&str>,
        end_date: Option<&str>,
    ) -> Result<Value, NativeError> {
        if !permissions.categories.calendar {
            return Err(NativeError::new(
                "permission",
                "De categorie 'Agenda-items' is uitgeschakeld.",
            ));
        }
        let checked_courses = permissions.check_courses(course_ids)?;
        let mut query_owned: Vec<(String, String)> = vec![("type".into(), "event".into())];
        for id in &checked_courses {
            query_owned.push(("context_codes[]".into(), format!("course_{id}")));
        }
        query_owned.push(("per_page".into(), PER_PAGE.into()));
        if let Some(sd) = start_date.map(str::trim).filter(|s| !s.is_empty()) {
            query_owned.push(("start_date".into(), sd.to_string()));
        } else {
            query_owned.push(("all_events".into(), "true".into()));
        }
        if let Some(ed) = end_date.map(str::trim).filter(|s| !s.is_empty()) {
            query_owned.push(("end_date".into(), ed.to_string()));
        }
        let query_refs: Vec<(&str, &str)> = query_owned
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let (items, truncated, warnings) = self
            .get_paginated_list("/api/v1/calendar_events", &query_refs)
            .await?;
        Ok(json!({
            "items": items,
            "truncated": truncated,
            "warnings": warnings,
            "retrievedAt": now_iso_approx(),
        }))
    }

    pub async fn fetch_modules(
        &self,
        permissions: &ReadPermissions,
        course_id: &str,
        search_term: Option<&str>,
    ) -> Result<Value, NativeError> {
        if !permissions.categories.modules {
            return Err(NativeError::new(
                "permission",
                "De categorie 'Modules en pagina's' is uitgeschakeld.",
            ));
        }
        let cid = permissions.check_course(course_id)?;
        let mut query: Vec<(&str, &str)> = vec![("per_page", PER_PAGE)];
        if let Some(st) = search_term.map(str::trim).filter(|s| !s.is_empty()) {
            query.push(("search_term", st));
        }
        let path = format!("/api/v1/courses/{cid}/modules");
        let (mut modules, mut truncated, mut warnings) =
            self.get_paginated_list(&path, &query).await?;

        for (idx, module_val) in modules.iter_mut().enumerate() {
            if idx >= MAX_MODULES_TO_EXPAND {
                truncated = true;
                warnings.push(format!(
                    "Module-items zijn geladen voor de eerste {MAX_MODULES_TO_EXPAND} modules."
                ));
                break;
            }
            let Some(mod_obj) = module_val.as_object_mut() else {
                continue;
            };
            let mod_id = match mod_obj.get("id") {
                Some(Value::Number(n)) => n.to_string(),
                Some(Value::String(s)) => s.clone(),
                _ => continue,
            };
            if !is_safe_id(&mod_id) {
                continue;
            }
            let items_path = format!("/api/v1/courses/{cid}/modules/{mod_id}/items");
            match self
                .get_paginated_list(&items_path, &[("per_page", PER_PAGE)])
                .await
            {
                Ok((mod_items, items_trunc, item_warns)) => {
                    if items_trunc {
                        truncated = true;
                    }
                    warnings.extend(item_warns);
                    // Enforce category isolation inside the built-in server:
                    // if `assignments` is disabled, strip Assignment/Quiz module items here too.
                    let filtered_items: Vec<Value> = mod_items
                        .into_iter()
                        .filter(|item| {
                            if permissions.categories.assignments {
                                return true;
                            }
                            let item_type = item
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            item_type != "Assignment" && item_type != "Quiz"
                        })
                        .collect();
                    mod_obj.insert("items".to_string(), Value::Array(filtered_items));
                }
                Err(err) => {
                    warnings.push(format!(
                        "Items van module {mod_id} konden niet worden geladen: {}",
                        err.message
                    ));
                }
            }
        }

        Ok(json!({
            "items": modules,
            "truncated": truncated,
            "warnings": warnings,
            "retrievedAt": now_iso_approx(),
        }))
    }

    pub async fn fetch_page(
        &self,
        permissions: &ReadPermissions,
        course_id: &str,
        page_url_or_id: &str,
    ) -> Result<Value, NativeError> {
        if !permissions.categories.modules {
            return Err(NativeError::new(
                "permission",
                "De categorie 'Modules en pagina's' is uitgeschakeld.",
            ));
        }
        let cid = permissions.check_course(course_id)?;
        let slug = page_url_or_id.trim();
        if !is_safe_page_locator(slug) {
            return Err(NativeError::new(
                "permission",
                "Ongeldige pagina-identificatie.",
            ));
        }
        let path = if slug == "front_page" {
            format!("/api/v1/courses/{cid}/front_page")
        } else {
            format!("/api/v1/courses/{cid}/pages/{slug}")
        };
        let token = self.resolve_token()?;
        let url = self.build_api_url(&path, &[])?;
        let (page, _) = self.get_single_page(&url, &token).await?;
        Ok(json!({
            "page": page,
            "truncated": false,
            "warnings": [],
            "retrievedAt": now_iso_approx(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injected_test_student_permissions_only_exist_in_feature_builds() {
        let raw = json!({
            "selectedCourseIds": ["101"],
            "categories": { "assignments": true, "submissions": true, "announcements": false, "calendar": false, "modules": false },
            "testStudentCourseIds": ["101"]
        });
        let parsed: ReadPermissions = serde_json::from_value(raw).unwrap();
        let reserialized = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            reserialized.get("testStudentCourseIds").is_some(),
            cfg!(feature = "canvas-test-mode")
        );
    }

    #[test]
    fn endpoint_allowlist_blocks_writes_and_unreviewed_paths_and_params() {
        let base = Url::parse("https://fhict.instructure.com").unwrap();

        // Allowed endpoints:
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/courses?enrollment_state=active&state[]=available&per_page=50").unwrap()
        )
        .is_ok());

        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/courses/101/assignments?override_assignment_dates=true&order_by=due_at&per_page=50").unwrap()
        )
        .is_ok());

        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/courses/101/students/submissions?per_page=50&assignment_ids[]=55").unwrap()
        )
        .is_ok());

        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/calendar_events?type=event&context_codes[]=course_101").unwrap()
        )
        .is_ok());

        // Allowed: own-user submission fetch via assignments `include[]=submission`
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/courses/101/assignments?include[]=submission").unwrap()
        )
        .is_ok());

        // Allowed: single course read for enrollment check
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/courses/101").unwrap()
        )
        .is_ok());

        // Blocked: unapproved `include[]` values (e.g. `all_dates`, `overrides`, `users`) or `include[]=submission` on non-assignment endpoints
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/courses/101/assignments?include[]=all_dates").unwrap()
        )
        .is_err());
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/courses/101/modules?include[]=submission").unwrap()
        )
        .is_err());

        // Blocked: arbitrary student submissions `student_ids[]=all` or `student_ids[]=999`
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/courses/101/students/submissions?student_ids[]=all").unwrap()
        )
        .is_err());
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/courses/101/students/submissions?student_ids[]=999").unwrap()
        )
        .is_err());

        // Blocked: calendar events without `type=event` or with `type=assignment`
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/calendar_events?type=assignment&context_codes[]=course_101").unwrap()
        )
        .is_err());
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/calendar_events?context_codes[]=course_101").unwrap()
        )
        .is_err());

        // Blocked: unreviewed endpoints (users, files, conversations, admin)
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/users/self").unwrap()
        )
        .is_err());
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://fhict.instructure.com/api/v1/courses/101/users").unwrap()
        )
        .is_err());

        // Blocked: cross-origin pagination URL
        assert!(validate_canvas_get_url(
            &base,
            &Url::parse("https://evil.example.com/api/v1/courses?page=2").unwrap()
        )
        .is_err());
    }

    #[test]
    fn link_header_extracts_rel_next() {
        let header = r#"<https://fhict.instructure.com/api/v1/courses?page=1&per_page=50>; rel="current", <https://fhict.instructure.com/api/v1/courses?page=2&per_page=50>; rel="next", <https://fhict.instructure.com/api/v1/courses?page=5&per_page=50>; rel="last""#;
        assert_eq!(
            parse_next_link(header).as_deref(),
            Some("https://fhict.instructure.com/api/v1/courses?page=2&per_page=50")
        );
        assert!(parse_next_link(r#"<https://fhict.instructure.com/api/v1/courses?page=1>; rel="prev""#).is_none());
    }
}
