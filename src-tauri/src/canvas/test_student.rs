//! Canvas Test Student reads. Compiled only with the `canvas-test-mode` Cargo feature, which
//! `scripts/desktop.mjs --testmode=true` enables together with the frontend flag.
use super::{api_v1_tail, is_safe_id, now_iso_approx, CanvasApiClient, ReadPermissions, PER_PAGE};
use crate::storage::NativeError;
use reqwest::Url;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

const fn is_literal_true(value: Option<&str>) -> bool {
    match value {
        Some(s) => {
            let b = s.as_bytes();
            b.len() == 4 && b[0] == b't' && b[1] == b'r' && b[2] == b'u' && b[3] == b'e'
        }
        None => false,
    }
}

/// True only when this native binary was compiled with `VITE_PLUMS_TESTMODE=true`, i.e. together with a
/// test-mode frontend. A feature-on binary built any other way keeps the exception disabled.
pub const FRONTEND_AGREES: bool = is_literal_true(option_env!("VITE_PLUMS_TESTMODE"));

pub fn ensure_build_agreement(frontend_agrees: bool) -> Result<(), NativeError> {
    if frontend_agrees {
        Ok(())
    } else {
        Err(NativeError::new(
            "permission",
            "Geweigerd: Canvas Test Student is alleen beschikbaar in een volledige testbuild (--testmode=true); native code en frontend komen niet overeen.",
        ))
    }
}

fn deny(message: impl Into<String>) -> NativeError {
    NativeError::new("permission", message)
}

fn is_page_number(v: &str) -> bool {
    !v.is_empty() && v.len() <= 4 && v.bytes().all(|b| b.is_ascii_digit())
}

/// Reviewed GET endpoints for the Test Student exception only:
/// - `GET /api/v1/courses/:course_id/users?enrollment_type[]=student_view` (find, never create, the Test Student)
/// - `GET /api/v1/courses/:course_id/students/submissions?student_ids[]=<resolved id>`
pub fn validate_test_student_url(
    base_origin: &Url,
    target: &Url,
    course_id: &str,
    resolved_student_id: Option<&str>,
) -> Result<(), NativeError> {
    let tail = api_v1_tail(base_origin, target)?;
    match tail.as_slice() {
        ["courses", cid, "users"] if *cid == course_id => {
            let mut saw_student_view = false;
            for (key, value) in target.query_pairs() {
                match (key.as_ref(), value.as_ref()) {
                    ("enrollment_type[]", "student_view") => saw_student_view = true,
                    ("per_page" | "page", v) if is_page_number(v) => {}
                    (k, _) => {
                        return Err(deny(format!(
                            "Geweigerd: queryparameter '{k}' is niet toegestaan bij het opzoeken van de Test Student."
                        )))
                    }
                }
            }
            if !saw_student_view {
                return Err(deny("Geweigerd: alleen enrollment_type[]=student_view is toegestaan."));
            }
            Ok(())
        }
        ["courses", cid, "students", "submissions"] if *cid == course_id => {
            let Some(student_id) = resolved_student_id else {
                return Err(deny("Geweigerd: de Test Student is nog niet server-side vastgesteld."));
            };
            let mut saw_student = false;
            for (key, value) in target.query_pairs() {
                match (key.as_ref(), value.as_ref()) {
                    ("student_ids[]", v) if v == student_id => saw_student = true,
                    ("assignment_ids[]", v) if is_safe_id(v) => {}
                    ("per_page" | "page", v) if is_page_number(v) => {}
                    (k, _) => {
                        return Err(deny(format!(
                            "Geweigerd: queryparameter '{k}' is niet toegestaan bij Test Student-inleveringen."
                        )))
                    }
                }
            }
            if !saw_student {
                return Err(deny("Geweigerd: inleveringen mogen alleen voor de vastgestelde Test Student worden gelezen."));
            }
            Ok(())
        }
        _ => Err(deny(format!(
            "Geweigerd: Canvas-endpoint '{}' hoort niet bij de Test Student-uitzondering.",
            target.path()
        ))),
    }
}

fn id_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

impl CanvasApiClient {
    pub async fn fetch_test_student_submissions(
        &self,
        permissions: &ReadPermissions,
        course_id: &str,
        assignment_ids: Option<&[String]>,
    ) -> Result<Value, NativeError> {
        ensure_build_agreement(FRONTEND_AGREES)?;
        self.fetch_test_student_submissions_checked(permissions, course_id, assignment_ids)
            .await
    }

    pub(crate) async fn fetch_test_student_submissions_checked(
        &self,
        permissions: &ReadPermissions,
        course_id: &str,
        assignment_ids: Option<&[String]>,
    ) -> Result<Value, NativeError> {
        if !permissions.categories.submissions {
            return Err(deny("De categorie 'Eigen inleverstatus' is uitgeschakeld."));
        }
        let cid = permissions.check_course(course_id)?;
        if !permissions.test_student_course_ids.iter().any(|c| c == &cid) {
            return Err(deny(format!(
                "Canvas Test Student is niet ingeschakeld voor cursus {cid} (Instellingen → Canvas)."
            )));
        }
        let mut filter_ids = Vec::new();
        for aid in assignment_ids.unwrap_or_default().iter().take(25) {
            let trimmed = aid.trim();
            if !is_safe_id(trimmed) {
                return Err(deny("Ongeldig opdracht-ID."));
            }
            filter_ids.push(trimmed.to_string());
        }

        let users_validator =
            |base: &Url, target: &Url| validate_test_student_url(base, target, &cid, None);
        let (users, _, _) = self
            .get_paginated_list_with(
                &format!("/api/v1/courses/{cid}/users"),
                &[("enrollment_type[]", "student_view"), ("per_page", PER_PAGE)],
                &users_validator,
            )
            .await?;
        let student = match users.as_slice() {
            [one] => one,
            [] => {
                return Err(NativeError::new(
                    "not-found",
                    format!("Er is geen Canvas Test Student in cursus {cid}. Open in Canvas eenmalig 'Studentweergave'; PLuMS maakt zelf geen Test Student aan."),
                ))
            }
            _ => {
                return Err(deny(format!(
                    "Geweigerd: Canvas gaf meer dan één student_view-gebruiker terug voor cursus {cid}."
                )))
            }
        };
        let student_id = id_string(student.get("id"))
            .filter(|id| is_safe_id(id))
            .ok_or_else(|| NativeError::new("protocol", "Canvas gaf geen geldig Test Student-ID terug."))?;
        let student_name = student
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Test Student")
            .to_string();

        let mut query_owned: Vec<(String, String)> = vec![("student_ids[]".into(), student_id.clone())];
        for aid in &filter_ids {
            query_owned.push(("assignment_ids[]".into(), aid.clone()));
        }
        query_owned.push(("per_page".into(), PER_PAGE.into()));
        let query_refs: Vec<(&str, &str)> = query_owned
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let submissions_validator = |base: &Url, target: &Url| {
            validate_test_student_url(base, target, &cid, Some(&student_id))
        };
        let (submissions, truncated, mut warnings) = self
            .get_paginated_list_with(
                &format!("/api/v1/courses/{cid}/students/submissions"),
                &query_refs,
                &submissions_validator,
            )
            .await?;

        // Titles and links come from the ordinary reviewed assignments read (no include[]).
        let mut assignment_info: HashMap<String, (Value, Value, Value)> = HashMap::new();
        match self
            .get_paginated_list(
                &format!("/api/v1/courses/{cid}/assignments"),
                &[("order_by", "due_at"), ("per_page", PER_PAGE)],
            )
            .await
        {
            Ok((assignments, _, _)) => {
                for a in assignments {
                    if let Some(aid) = id_string(a.get("id")) {
                        assignment_info.insert(
                            aid,
                            (
                                a.get("name").cloned().unwrap_or(Value::Null),
                                a.get("due_at").cloned().unwrap_or(Value::Null),
                                a.get("html_url").cloned().unwrap_or(Value::Null),
                            ),
                        );
                    }
                }
            }
            Err(err) => warnings.push(format!("Opdrachttitels konden niet worden geladen: {}", err.message)),
        }

        let mut items = Vec::new();
        for sub in submissions {
            let Some(obj) = sub.as_object() else { continue };
            if id_string(obj.get("user_id")).as_deref() != Some(student_id.as_str()) {
                continue;
            }
            let Some(aid) = id_string(obj.get("assignment_id")) else { continue };
            let (name, base_due, html_url) = assignment_info
                .get(&aid)
                .cloned()
                .unwrap_or((Value::Null, Value::Null, Value::Null));
            let due_at = match obj.get("cached_due_date") {
                Some(Value::String(s)) => Value::String(s.clone()),
                _ => base_due,
            };
            let mut item = Map::new();
            for key in ["workflow_state", "submitted_at", "late", "missing", "excused", "graded_at", "score", "grade"] {
                if let Some(v) = obj.get(key) {
                    item.insert(key.into(), v.clone());
                }
            }
            item.insert("assignment_id".into(), Value::String(aid));
            item.insert("course_id".into(), Value::String(cid.clone()));
            item.insert(
                "assignment_name".into(),
                if name.is_null() { Value::String("Opdracht".into()) } else { name },
            );
            item.insert("due_at".into(), due_at);
            item.insert("html_url".into(), html_url);
            item.insert("test_student".into(), Value::Bool(true));
            items.push(Value::Object(item));
        }

        warnings.insert(
            0,
            format!("TESTBUILD: dit zijn gegevens van de Canvas Test Student ('{student_name}') in cursus {cid}, niet van het eigen account."),
        );
        Ok(json!({
            "items": items,
            "subject": "canvas_test_student",
            "testStudent": { "name": student_name },
            "enrollmentStatus": "test_student",
            "truncated": truncated,
            "warnings": warnings,
            "retrievedAt": now_iso_approx(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas::{validate_canvas_get_url, CategoryPermissions};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn base() -> Url {
        Url::parse("https://canvas.example.test").unwrap()
    }

    fn url(s: &str) -> Url {
        Url::parse(&format!("https://canvas.example.test{s}")).unwrap()
    }

    fn perms(test_courses: &[&str], submissions: bool) -> ReadPermissions {
        ReadPermissions {
            selected_course_ids: vec!["101".into(), "202".into()],
            categories: CategoryPermissions {
                assignments: true,
                submissions,
                ..Default::default()
            },
            test_student_course_ids: test_courses.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn literal_true_only() {
        assert!(is_literal_true(Some("true")));
        for v in [None, Some("false"), Some("TRUE"), Some("1"), Some("yes"), Some("")] {
            assert!(!is_literal_true(v));
        }
        assert_eq!(FRONTEND_AGREES, option_env!("VITE_PLUMS_TESTMODE") == Some("true"));
    }

    #[test]
    fn mismatch_denies() {
        let err = ensure_build_agreement(false).unwrap_err();
        assert_eq!(err.kind, "permission");
        assert!(ensure_build_agreement(true).is_ok());
    }

    #[test]
    fn test_student_validator_is_narrow() {
        let b = base();
        let ok = |p: &str, sid: Option<&str>| validate_test_student_url(&b, &url(p), "101", sid).is_ok();
        assert!(ok("/api/v1/courses/101/users?enrollment_type%5B%5D=student_view&per_page=50", None));
        assert!(ok("/api/v1/courses/101/users?enrollment_type[]=student_view&page=2&per_page=50", None));
        assert!(!ok("/api/v1/courses/101/users?enrollment_type[]=student&per_page=50", None));
        assert!(!ok("/api/v1/courses/101/users?per_page=50", None));
        assert!(!ok("/api/v1/courses/101/users?enrollment_type[]=student_view&include[]=email", None));
        assert!(!ok("/api/v1/courses/202/users?enrollment_type[]=student_view", None));
        assert!(!ok("/api/v1/courses/101/student_view_student", None));

        assert!(ok("/api/v1/courses/101/students/submissions?student_ids[]=77&per_page=50", Some("77")));
        assert!(ok("/api/v1/courses/101/students/submissions?student_ids[]=77&assignment_ids[]=5", Some("77")));
        assert!(!ok("/api/v1/courses/101/students/submissions?student_ids[]=77", None));
        assert!(!ok("/api/v1/courses/101/students/submissions?student_ids[]=78", Some("77")));
        assert!(!ok("/api/v1/courses/101/students/submissions?student_ids[]=all", Some("77")));
        assert!(!ok("/api/v1/courses/101/students/submissions?student_ids[]=77&student_ids[]=78", Some("77")));
        assert!(!ok("/api/v1/courses/101/students/submissions?per_page=50", Some("77")));
        assert!(!ok("/api/v1/courses/101/assignments", Some("77")));
        assert!(validate_test_student_url(
            &b,
            &Url::parse("https://evil.example/api/v1/courses/101/users?enrollment_type[]=student_view").unwrap(),
            "101",
            None
        )
        .is_err());

        // The ordinary allowlist still refuses both test endpoints.
        assert!(validate_canvas_get_url(&b, &url("/api/v1/courses/101/users?enrollment_type[]=student_view")).is_err());
        assert!(validate_canvas_get_url(&b, &url("/api/v1/courses/101/students/submissions?student_ids[]=77")).is_err());
    }

    #[tokio::test]
    async fn permission_checks_run_before_network() {
        let client = CanvasApiClient::new_for_test("http://127.0.0.1:9", "tok");
        let err = client
            .fetch_test_student_submissions_checked(&perms(&[], true), "101", None)
            .await
            .unwrap_err();
        assert!(err.message.contains("niet ingeschakeld"));
        let err = client
            .fetch_test_student_submissions_checked(&perms(&["101"], false), "101", None)
            .await
            .unwrap_err();
        assert!(err.message.contains("uitgeschakeld"));
        let err = client
            .fetch_test_student_submissions_checked(&perms(&["303"], true), "303", None)
            .await
            .unwrap_err();
        assert!(err.message.contains("niet geselecteerd"));
    }

    #[tokio::test]
    async fn resolves_test_student_server_side_and_reads_only_that_user() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let line = req.lines().next().unwrap_or("").to_string();
                    let body = if line.starts_with("GET /api/v1/courses/101/users?") {
                        assert!(line.contains("enrollment_type%5B%5D=student_view"));
                        r#"[{"id":77,"name":"Test Student"}]"#
                    } else if line.starts_with("GET /api/v1/courses/101/students/submissions?") {
                        assert!(line.contains("student_ids%5B%5D=77"));
                        r#"[{"assignment_id":555,"user_id":77,"workflow_state":"unsubmitted","submitted_at":null,"cached_due_date":"2026-10-20T21:59:00Z","missing":false},{"assignment_id":556,"user_id":12,"workflow_state":"submitted"}]"#
                    } else if line.starts_with("GET /api/v1/courses/101/assignments?") {
                        assert!(!line.contains("include"));
                        r#"[{"id":555,"name":"Portfolio Opdracht","due_at":"2026-10-18T21:59:00Z","html_url":"https://canvas/x"}]"#
                    } else {
                        "[]"
                    };
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                });
            }
        });

        let client = CanvasApiClient::new_for_test(&base_url, "tok");
        let res = client
            .fetch_test_student_submissions_checked(&perms(&["101"], true), "101", None)
            .await
            .unwrap();
        assert_eq!(res["subject"], "canvas_test_student");
        let items = res["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "only the resolved Test Student's submission is returned");
        assert_eq!(items[0]["assignment_id"], "555");
        assert_eq!(items[0]["due_at"], "2026-10-20T21:59:00Z");
        assert_eq!(items[0]["assignment_name"], "Portfolio Opdracht");
        assert!(items[0].get("user_id").is_none());
        assert!(res["warnings"][0].as_str().unwrap().starts_with("TESTBUILD"));
        server.abort();
    }
}
