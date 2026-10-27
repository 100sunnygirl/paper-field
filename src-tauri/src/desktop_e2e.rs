//! Deliberately absent from normal builds. This is not an application feature.
//! The runner owns this disposable root; no production profile or OS keychain is used.
use std::fs;
use std::path::{Path, PathBuf};

const MARKER: &str = "paper-field desktop smoke\n";

fn validate_root(root: &Path, temporary: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute() || !root.is_dir() {
        return Err("PF_E2E_ROOT must be an existing absolute directory".into());
    }
    let canonical = dunce::canonicalize(root).map_err(|err| err.to_string())?;
    let temporary = dunce::canonicalize(temporary).map_err(|err| err.to_string())?;
    if !canonical.starts_with(&temporary)
        || !canonical.file_name().and_then(|s| s.to_str()).is_some_and(|s| s.starts_with("paper-field-e2e-"))
        || !matches!(fs::read_to_string(canonical.join(".paper-field-e2e")).as_deref(), Ok(MARKER))
    {
        return Err("PF_E2E_ROOT must be a marked paper-field-e2e-* directory inside the OS temp directory".into());
    }
    Ok(canonical)
}

fn root() -> Result<PathBuf, String> {
    let root = std::env::var_os("PF_E2E_ROOT").ok_or("PF_E2E_ROOT is required for desktop-e2e binaries")?;
    validate_root(Path::new(&root), &std::env::temp_dir())
}

pub(crate) fn profile_dir() -> Result<PathBuf, String> {
    let root = root()?;
    let profile = root.join("profile");
    fs::create_dir_all(&profile).map_err(|err| err.to_string())?;
    if dunce::canonicalize(&profile).map_err(|err| err.to_string())? != profile {
        return Err("desktop-e2e profile must not be a symlink".into());
    }
    Ok(profile)
}

pub(crate) fn fixture_pdf() -> Result<PathBuf, String> {
    let root = root()?;
    let fixture = root.join("smoke.pdf");
    if !fixture.is_file() || dunce::canonicalize(&fixture).map_err(|err| err.to_string())? != fixture {
        return Err("desktop-e2e requires a regular, non-symlink smoke.pdf in its root".into());
    }
    // The caller still applies the production canonical-PDF validation and grants.
    Ok(fixture)
}

pub(crate) fn record_process() -> Result<(), String> {
    fs::write(root()?.join("process-id"), std::process::id().to_string()).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_must_be_marked_and_inside_temporary_directory() {
        let temp = crate::test_util::unique_temp_dir("e2e-root-validation");
        let root = temp.join("paper-field-e2e-validation");
        fs::create_dir_all(&root).unwrap();
        assert!(validate_root(&root, &temp).is_err());
        fs::write(root.join(".paper-field-e2e"), MARKER).unwrap();
        assert_eq!(validate_root(&root, &temp).unwrap(), dunce::canonicalize(&root).unwrap());
        let other = temp.join("other");
        fs::create_dir_all(&other).unwrap();
        assert!(validate_root(&root, &other).is_err());
        assert!(validate_root(Path::new("paper-field-e2e-relative"), &temp).is_err());
        fs::remove_dir_all(temp).unwrap();
    }
}
