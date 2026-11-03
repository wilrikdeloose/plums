use serde::Serialize;
use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DATA_FILE: &str = "your.data";

#[derive(Debug, Serialize)]
pub struct NativeError {
    pub kind: &'static str,
    pub message: String,
}

impl NativeError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// Directory that holds your.data: next to the executable, or next to the
/// outermost `.app` bundle when the executable lives inside one (macOS).
pub fn data_dir_for(exe: &Path, inside_bundles: bool) -> Option<PathBuf> {
    if inside_bundles {
        let outer_bundle = exe
            .ancestors()
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app")))
            .last();
        if let Some(bundle) = outer_bundle {
            return bundle.parent().map(Path::to_path_buf);
        }
    }
    exe.parent().map(Path::to_path_buf)
}

pub fn data_file() -> Result<PathBuf, NativeError> {
    let exe = std::env::current_exe().map_err(|e| {
        NativeError::new(
            "unavailable",
            format!("Locatie van het programma onbekend: {e}"),
        )
    })?;
    let dir = data_dir_for(&exe, cfg!(target_os = "macos"))
        .ok_or_else(|| NativeError::new("unavailable", "Map van het programma onbekend."))?;
    Ok(dir.join(DATA_FILE))
}

pub fn load(path: &Path) -> Result<Option<String>, NativeError> {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| {
            NativeError::new(
                "malformed",
                format!("{} is geen geldige UTF-8-tekst.", path.display()),
            )
        }),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(NativeError::new(
            "read",
            format!("Lezen van {} mislukt: {e}", path.display()),
        )),
    }
}

/// Writes to a temporary file in the same directory, flushes it to disk and
/// renames it over the target, so a crash never leaves a half-written file.
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), NativeError> {
    let dir = path
        .parent()
        .ok_or_else(|| NativeError::new("write", "Doelmap onbekend."))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(DATA_FILE);
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = File::create(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        NativeError::new(
            "write",
            format!("Schrijven naar {} mislukt: {e}", path.display()),
        )
    })
}

pub fn clear(path: &Path) -> Result<(), NativeError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(NativeError::new(
            "write",
            format!("Verwijderen van {} mislukt: {e}", path.display()),
        )),
    }
}

/// Renames unreadable data aside (never deletes it) and returns the new path.
pub fn quarantine(path: &Path) -> Result<PathBuf, NativeError> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let target = path.with_file_name(format!("{DATA_FILE}.onleesbaar-{stamp}"));
    match fs::rename(path, &target) {
        Ok(()) => Ok(target),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(target),
        Err(e) => Err(NativeError::new(
            "write",
            format!("Apart zetten van {} mislukt: {e}", path.display()),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_is_next_to_executable() {
        let exe = Path::new("/opt/plums/plums");
        assert_eq!(data_dir_for(exe, true), Some(PathBuf::from("/opt/plums")));
        let exe = Path::new(r"C:\Apps\PLuMS\plums.exe");
        assert_eq!(
            data_dir_for(exe, false),
            Some(PathBuf::from(r"C:\Apps\PLuMS"))
        );
    }

    #[test]
    fn data_dir_is_next_to_outer_app_bundle() {
        let exe =
            Path::new("/Users/s/Apps/PLuMS.app/Contents/Helpers/Inner.app/Contents/MacOS/plums");
        assert_eq!(
            data_dir_for(exe, true),
            Some(PathBuf::from("/Users/s/Apps"))
        );
    }

    #[test]
    fn atomic_write_load_clear_and_quarantine() {
        let dir = std::env::temp_dir().join(format!("plums-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(DATA_FILE);
        assert!(load(&file).unwrap().is_none());

        write_atomic(&file, "{\n  \"a\": \"één\"\n}\n").unwrap();
        write_atomic(&file, "{\n  \"a\": \"twee\"\n}\n").unwrap();
        assert_eq!(load(&file).unwrap().unwrap(), "{\n  \"a\": \"twee\"\n}\n");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());

        fs::write(&file, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(load(&file).unwrap_err().kind, "malformed");

        let kept = quarantine(&file).unwrap();
        assert!(kept.exists() && !file.exists());

        write_atomic(&file, "{}").unwrap();
        clear(&file).unwrap();
        assert!(!file.exists());
        clear(&file).unwrap();

        fs::remove_dir_all(&dir).unwrap();
    }
}
