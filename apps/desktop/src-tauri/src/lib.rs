use aangan_types::HardwareProfile;
use fitcalc::{Recommendation, Tunables, recommend};
use hwprobe::{ProbeOptions, probe};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

mod catalog;

const MAX_TEXT_FILE_BYTES: usize = 5 * 1024 * 1024;
const BUNDLED_CATALOG: &str = include_str!("../../../../catalog/models.v1.json");

#[derive(Serialize)]
struct SavedFile {
    path: String,
    bytes: usize,
}

#[derive(Serialize)]
struct AppPaths {
    data_dir: String,
    data_dir_exists: bool,
}

fn app_paths_for_existing_dir(data_dir: &Path) -> Result<AppPaths, String> {
    if !data_dir.is_absolute() {
        return Err("the data directory must be absolute".to_string());
    }
    Ok(AppPaths {
        data_dir: data_dir.to_string_lossy().into_owned(),
        data_dir_exists: true,
    })
}

#[tauri::command]
fn get_app_paths(app: tauri::AppHandle) -> Result<AppPaths, String> {
    let data_dir = app_data_dir(&app)?;
    app_paths_for_existing_dir(&data_dir)
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("could not create the application data directory: {error}"))?;
    Ok(data_dir)
}

#[tauri::command]
async fn scan_hardware(measure_bandwidth: bool) -> Result<HardwareProfile, String> {
    tauri::async_runtime::spawn_blocking(move || probe(&ProbeOptions { measure_bandwidth }))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn recommend_models(
    app: tauri::AppHandle,
    profile: HardwareProfile,
    context: u32,
) -> Result<Vec<Recommendation>, String> {
    let loaded = catalog::load_catalog(&app_data_dir(&app)?, BUNDLED_CATALOG)?;
    Ok(recommend(
        &profile,
        &catalog::model_specs(&loaded.catalog),
        context,
        &Tunables::default(),
    ))
}

#[tauri::command]
fn get_catalog_info(app: tauri::AppHandle) -> Result<catalog::CatalogInfo, String> {
    catalog::catalog_info(&app_data_dir(&app)?, BUNDLED_CATALOG)
}

#[tauri::command]
fn set_subscribed_families(
    app: tauri::AppHandle,
    families: Vec<String>,
) -> Result<catalog::CatalogInfo, String> {
    catalog::set_subscribed_families(&app_data_dir(&app)?, BUNDLED_CATALOG, families)
}

#[tauri::command]
fn set_catalog_refresh_consent(app: tauri::AppHandle, always_allowed: bool) -> Result<(), String> {
    catalog::set_refresh_consent(&app_data_dir(&app)?, always_allowed)
}

#[tauri::command]
fn reset_catalog(app: tauri::AppHandle) -> Result<catalog::CatalogInfo, String> {
    catalog::reset_catalog(&app_data_dir(&app)?, BUNDLED_CATALOG)
}

#[tauri::command]
async fn refresh_catalog(
    app: tauri::AppHandle,
    consent_once: bool,
) -> Result<catalog::RefreshResult, String> {
    catalog::refresh_catalog(&app_data_dir(&app)?, BUNDLED_CATALOG, consent_once).await
}

fn validate_save_request(
    path: &Path,
    contents: &str,
    parent_is_directory: bool,
) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("the path must be absolute".to_string());
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .ok_or_else(|| "the file extension must be .json or .txt".to_string())?;
    if !extension.eq_ignore_ascii_case("json") && !extension.eq_ignore_ascii_case("txt") {
        return Err("the file extension must be .json or .txt".to_string());
    }
    if !parent_is_directory {
        return Err("the parent directory does not exist".to_string());
    }
    if contents.len() > MAX_TEXT_FILE_BYTES {
        return Err("the report must be no larger than 5 MiB".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn save_text_file(path: String, contents: String) -> Result<SavedFile, String> {
    tauri::async_runtime::spawn_blocking(move || save_text_file_blocking(&path, &contents))
        .await
        .map_err(|error| error.to_string())?
}

fn save_text_file_blocking(path: &str, contents: &str) -> Result<SavedFile, String> {
    let path = Path::new(path);
    let parent = path
        .parent()
        .ok_or_else(|| "the parent directory does not exist".to_string())?;
    validate_save_request(path, contents, parent.is_dir())?;

    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("could not create a temporary file: {error}"))?;
    temporary
        .write_all(contents.as_bytes())
        .map_err(|error| format!("could not write the report: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("could not flush the report: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("could not save the report: {}", error.error))?;

    Ok(SavedFile {
        path: path.to_string_lossy().into_owned(),
        bytes: contents.len(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_hardware,
            recommend_models,
            get_catalog_info,
            set_subscribed_families,
            set_catalog_refresh_consent,
            reset_catalog,
            refresh_catalog,
            save_text_file,
            get_app_paths
        ])
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(data_dir)?;
            #[cfg(windows)]
            {
                let icon = tauri::image::Image::from_app_icon_resource(128)?;
                let window = app.get_webview_window("main").ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "main window was not created")
                })?;
                window.set_icon(icon)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_TEXT_FILE_BYTES, app_paths_for_existing_dir, save_text_file_blocking,
        validate_save_request,
    };
    use std::path::Path;

    #[test]
    fn save_validation_rejects_relative_paths() {
        let error = validate_save_request(Path::new("report.json"), "{}", true)
            .expect_err("relative path should be rejected");
        assert!(error.contains("absolute"));
    }

    #[test]
    fn save_validation_rejects_unsupported_extensions() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let error = validate_save_request(&directory.path().join("report.csv"), "{}", true)
            .expect_err("unsupported extension should be rejected");
        assert!(error.contains("extension"));
    }

    #[test]
    fn save_validation_rejects_oversize_contents() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let contents = "x".repeat(MAX_TEXT_FILE_BYTES + 1);
        let error = validate_save_request(&directory.path().join("report.txt"), &contents, true)
            .expect_err("oversize contents should be rejected");
        assert!(error.contains("5 MiB"));
    }

    #[test]
    fn save_writes_exact_bytes_and_overwrites_existing_files() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("report.json");
        let contents = "{\"report\":\"Aangan\"}";

        let saved =
            save_text_file_blocking(path.to_string_lossy().as_ref(), contents).expect("first save");
        assert_eq!(saved.path, path.to_string_lossy());
        assert_eq!(saved.bytes, contents.len());
        assert_eq!(
            std::fs::read(&path).expect("read saved report"),
            contents.as_bytes()
        );

        let replacement = "{\"report\":\"updated\"}";
        save_text_file_blocking(path.to_string_lossy().as_ref(), replacement).expect("overwrite");
        assert_eq!(
            std::fs::read(&path).expect("read overwritten report"),
            replacement.as_bytes()
        );
    }

    #[test]
    fn app_paths_use_the_existing_absolute_data_directory() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let paths = app_paths_for_existing_dir(directory.path()).expect("app paths");
        let data_dir = Path::new(&paths.data_dir);

        assert!(data_dir.is_absolute());
        assert!(data_dir.is_dir());
        assert!(paths.data_dir_exists);
        assert_eq!(data_dir, directory.path());
    }
}
