use aangan_types::HardwareProfile;
use fitcalc::{Recommendation, Tunables, builtin_catalog, recommend};
use hwprobe::{ProbeOptions, probe};
#[cfg(windows)]
use tauri::Manager;

#[tauri::command]
async fn scan_hardware(measure_bandwidth: bool) -> Result<HardwareProfile, String> {
    tauri::async_runtime::spawn_blocking(move || probe(&ProbeOptions { measure_bandwidth }))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn recommend_models(profile: HardwareProfile, context: u32) -> Vec<Recommendation> {
    recommend(&profile, &builtin_catalog(), context, &Tunables::default())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![scan_hardware, recommend_models])
        .setup(|_app| {
            #[cfg(windows)]
            {
                let icon = tauri::image::Image::from_app_icon_resource(128)?;
                let window = _app.get_webview_window("main").ok_or_else(|| {
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
