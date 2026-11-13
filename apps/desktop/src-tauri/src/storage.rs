use crate::catalog::{self, Catalog, ModelDownloadInfo};
use aangan_net::{DownloadSpec, Purpose};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};

pub const MIN_MODEL_FOLDER_FREE_BYTES: u64 = 1_000_000_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub model_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub model_folder: String,
    pub model_files: Vec<StorageFile>,
    pub incomplete_downloads: Vec<StorageFile>,
    pub catalog_cache_bytes: u64,
    pub total_bytes: u64,
}

pub fn default_model_folder(data_dir: &Path) -> PathBuf {
    data_dir.join("models")
}

pub fn current_model_folder(data_dir: &Path) -> Result<PathBuf, String> {
    let default = default_model_folder(data_dir);
    catalog::model_folder(data_dir, &default)
}

pub fn validate_model_folder(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Choose an absolute model folder path.".into());
    }
    if !path.is_dir() {
        return Err("The selected model folder does not exist or is not a directory.".into());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("could not resolve the selected model folder: {error}"))?;
    let free = fs4::available_space(&canonical)
        .map_err(|error| format!("could not check free space in the model folder: {error}"))?;
    ensure_free_space(free)?;
    let test_file = tempfile::NamedTempFile::new_in(&canonical)
        .map_err(|error| format!("the selected model folder is not writable: {error}"))?;
    drop(test_file);
    Ok(canonical)
}

fn ensure_free_space(free: u64) -> Result<(), String> {
    if free < MIN_MODEL_FOLDER_FREE_BYTES {
        return Err(format!(
            "The model folder needs at least 1 GB of free space; {free} bytes are available."
        ));
    }
    Ok(())
}

pub async fn model_destination(root: &Path, model: &ModelDownloadInfo) -> Result<PathBuf, String> {
    let spec = download_spec(root, model)?;
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|error| format!("could not create the model folder: {error}"))?;
    let root = tokio::fs::canonicalize(root)
        .await
        .map_err(|error| format!("could not resolve the model folder: {error}"))?;
    let family_dir = root.join(&model.family);
    tokio::fs::create_dir_all(&family_dir)
        .await
        .map_err(|error| format!("could not create the model family folder: {error}"))?;
    let family_dir = tokio::fs::canonicalize(family_dir)
        .await
        .map_err(|error| format!("could not resolve the model family folder: {error}"))?;
    if !family_dir.starts_with(&root) {
        return Err("The model family folder resolves outside the managed model folder.".into());
    }
    let destination = family_dir.join(
        spec.dest
            .file_name()
            .ok_or_else(|| "The model filename is invalid.".to_string())?,
    );
    match tokio::fs::symlink_metadata(&destination).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("The model destination is not a regular file.".into())
        }
        Ok(_) => Ok(destination),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(destination),
        Err(error) => Err(format!("could not inspect the model destination: {error}")),
    }
}

pub fn download_spec(root: &Path, model: &ModelDownloadInfo) -> Result<DownloadSpec, String> {
    if !root.is_absolute() || !is_single_path_component(&model.family) {
        return Err("The model folder or family path is invalid.".into());
    }
    if !is_single_path_component(&model.file) || !model.file.to_ascii_lowercase().ends_with(".gguf")
    {
        return Err("The model filename is invalid.".into());
    }
    Ok(DownloadSpec {
        id: model.id.clone(),
        url: model.url.clone(),
        dest: root.join(&model.family).join(&model.file),
        sha256: model.sha256.clone(),
        size: model.size_bytes,
        purpose: Purpose::ModelDownload,
    })
}

pub fn download_specs_for_roots(
    catalog_data: &Catalog,
    roots: &[PathBuf],
) -> Result<Vec<DownloadSpec>, String> {
    let models = catalog::model_download_infos(catalog_data);
    roots
        .iter()
        .flat_map(|root| models.iter().map(move |model| (root, model)))
        .map(|(root, model)| download_spec(root, model))
        .collect()
}

fn is_single_path_component(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['/', '\\', ':'])
        && value != "."
        && value != ".."
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && Path::new(value).components().count() == 1
}

pub fn storage_info(data_dir: &Path, catalog_data: &Catalog) -> Result<StorageInfo, String> {
    let default = default_model_folder(data_dir);
    let current = catalog::model_folder(data_dir, &default)?;
    let roots = catalog::managed_model_folders(data_dir, &default)?;
    let downloads = catalog::model_download_infos(catalog_data);
    let mut model_files = Vec::new();
    let mut incomplete_downloads = Vec::new();
    let mut total_bytes = 0_u64;
    let mut seen_files = HashSet::new();
    for root in roots {
        let canonical_root = match fs::canonicalize(&root) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "could not resolve managed model folder {}: {error}",
                    root.display()
                ));
            }
        };
        collect_model_files(
            &canonical_root,
            &canonical_root,
            &downloads,
            &mut model_files,
            &mut incomplete_downloads,
            &mut total_bytes,
            &mut seen_files,
        )?;
    }
    let catalog_cache = catalog::cache_path(data_dir);
    let catalog_cache_bytes = match fs::metadata(&catalog_cache) {
        Ok(metadata) if metadata.is_file() => metadata.len(),
        Ok(_) => {
            return Err("the catalog cache path is not a file".into());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(format!("could not inspect the catalog cache: {error}"));
        }
    };
    total_bytes = total_bytes.saturating_add(catalog_cache_bytes);
    model_files.sort_by(|left, right| left.path.cmp(&right.path));
    incomplete_downloads.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(StorageInfo {
        model_folder: current.to_string_lossy().into_owned(),
        model_files,
        incomplete_downloads,
        catalog_cache_bytes,
        total_bytes,
    })
}

fn collect_model_files(
    root: &Path,
    directory: &Path,
    downloads: &[ModelDownloadInfo],
    models: &mut Vec<StorageFile>,
    incomplete: &mut Vec<StorageFile>,
    total_bytes: &mut u64,
    seen_files: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("could not list {}: {error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("could not read a storage entry: {error}"))?;
        let entry_path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("could not inspect {}: {error}", entry_path.display()))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            let canonical = fs::canonicalize(&entry_path)
                .map_err(|error| format!("could not resolve {}: {error}", entry_path.display()))?;
            if canonical.starts_with(root) {
                collect_model_files(
                    root,
                    &canonical,
                    downloads,
                    models,
                    incomplete,
                    total_bytes,
                    seen_files,
                )?;
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_partial = name.to_ascii_lowercase().ends_with(".gguf.part");
        let is_model = Path::new(&name)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"));
        if !is_partial && !is_model {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("could not inspect {}: {error}", entry_path.display()))?;
        let canonical_file = fs::canonicalize(&entry_path)
            .map_err(|error| format!("could not resolve {}: {error}", entry_path.display()))?;
        if !canonical_file.starts_with(root) || !seen_files.insert(canonical_file.clone()) {
            continue;
        }
        let size_bytes = metadata.len();
        *total_bytes = total_bytes.saturating_add(size_bytes);
        let model_id = model_id_for_path(root, &canonical_file, downloads, is_partial);
        let file = StorageFile {
            path: canonical_file.to_string_lossy().into_owned(),
            name,
            size_bytes,
            model_id,
        };
        if is_partial {
            incomplete.push(file);
        } else {
            models.push(file);
        }
    }
    Ok(())
}

fn model_id_for_path(
    root: &Path,
    path: &Path,
    downloads: &[ModelDownloadInfo],
    partial: bool,
) -> Option<String> {
    downloads.iter().find_map(|model| {
        let destination = root.join(&model.family).join(&model.file);
        let expected = if partial {
            let mut name = destination.file_name()?.to_os_string();
            name.push(".part");
            destination.with_file_name(name)
        } else {
            destination
        };
        (expected == path).then(|| model.id.clone())
    })
}

pub fn safe_managed_file(data_dir: &Path, requested: &Path) -> Result<PathBuf, String> {
    let default = default_model_folder(data_dir);
    let roots = catalog::managed_model_folders(data_dir, &default)?;
    let mut canonical_roots = Vec::new();
    for root in roots {
        match fs::canonicalize(&root) {
            Ok(path) if path.is_dir() => {
                if !canonical_roots.contains(&path) {
                    canonical_roots.push(path);
                }
            }
            Ok(_) => {
                return Err(format!(
                    "managed model folder is not a directory: {}",
                    root.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "could not resolve managed model folder {}: {error}",
                    root.display()
                ));
            }
        }
    }
    if canonical_roots.is_empty() {
        return Err("there are no available managed model folders".into());
    }
    let requested_metadata = fs::symlink_metadata(requested)
        .map_err(|error| format!("could not inspect the selected model file: {error}"))?;
    if requested_metadata.file_type().is_symlink() {
        return Err("symbolic links are not managed model files".into());
    }
    let canonical_file = fs::canonicalize(requested)
        .map_err(|error| format!("could not resolve the model file: {error}"))?;
    if !canonical_file.is_file()
        || !canonical_roots
            .iter()
            .any(|root| canonical_file.starts_with(root))
    {
        return Err("the selected file is outside the managed model folders".into());
    }
    let extension = canonical_file
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "the selected model file has an invalid name".to_string())?;
    if !extension.ends_with(".gguf") && !extension.ends_with(".gguf.part") {
        return Err("only model files and incomplete model downloads can be changed".into());
    }
    Ok(canonical_file)
}

pub fn delete_managed_file(data_dir: &Path, requested: &Path) -> Result<(), String> {
    let path = safe_managed_file(data_dir, requested)?;
    fs::remove_file(&path)
        .map_err(|error| format!("could not delete {}: {error}", path.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| "could not determine the model file folder".to_string())?;
    let default = default_model_folder(data_dir);
    let mut canonical_roots = Vec::new();
    for root in catalog::managed_model_folders(data_dir, &default)? {
        let canonical_root = match fs::canonicalize(root) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("could not resolve a managed model folder: {error}"));
            }
        };
        if !canonical_roots.contains(&canonical_root) {
            canonical_roots.push(canonical_root);
        }
    }
    if !canonical_roots.iter().any(|root| root.as_path() == parent) {
        let is_managed = canonical_roots.iter().any(|root| parent.starts_with(root));
        if is_managed {
            match fs::remove_dir(parent) {
                Ok(()) => {}
                Err(error)
                    if error.kind() == std::io::ErrorKind::DirectoryNotEmpty
                        || error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "model file was deleted, but its empty folder could not be removed: {error}"
                    ));
                }
            }
        }
    }
    Ok(())
}

pub fn managed_file_parent(data_dir: &Path, requested: &Path) -> Result<PathBuf, String> {
    let path = safe_managed_file(data_dir, requested)?;
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "could not determine the model file folder".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_deletion_outside_managed_model_roots() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let data_dir = temp.path().join("data");
        let managed = default_model_folder(&data_dir);
        let outside = temp.path().join("outside.gguf");
        fs::create_dir_all(&managed).expect("managed model folder");
        fs::write(&outside, b"keep").expect("outside file");

        let error = delete_managed_file(&data_dir, &outside).expect_err("outside path rejected");

        assert!(error.contains("outside the managed"));
        assert!(outside.exists());
    }

    #[test]
    fn deletes_a_model_file_inside_a_managed_root() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let data_dir = temp.path().join("data");
        let model = default_model_folder(&data_dir)
            .join("qwen")
            .join("model.gguf");
        fs::create_dir_all(model.parent().expect("model parent")).expect("model directory");
        fs::write(&model, b"model").expect("model file");

        delete_managed_file(&data_dir, &model).expect("managed model can be deleted");

        assert!(!model.exists());
        assert!(!model.parent().expect("model parent").exists());
    }

    #[test]
    fn keeps_nonempty_model_folder_after_deletion() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let data_dir = temp.path().join("data");
        let folder = default_model_folder(&data_dir).join("qwen");
        let model = folder.join("model.gguf");
        fs::create_dir_all(&folder).expect("model directory");
        fs::write(&model, b"model").expect("model file");
        fs::write(folder.join("other.gguf"), b"other").expect("other model file");

        delete_managed_file(&data_dir, &model).expect("managed model can be deleted");

        assert!(!model.exists());
        assert!(folder.exists());
    }

    #[test]
    fn maps_partial_files_to_their_download_id() {
        let catalog = catalog::validate_catalog_json(
            include_str!("../../../../catalog/models.v1.json").as_bytes(),
        )
        .expect("bundled catalog");
        let model = catalog::model_download_infos(&catalog)
            .into_iter()
            .next()
            .expect("catalog download metadata");
        let temp = tempfile::tempdir().expect("temporary directory");
        let data_dir = temp.path().join("data");
        let partial = default_model_folder(&data_dir)
            .join(&model.family)
            .join(format!("{}.part", model.file));
        fs::create_dir_all(partial.parent().expect("partial parent")).expect("model directory");
        fs::write(&partial, b"partial").expect("partial download");

        let info = storage_info(&data_dir, &catalog).expect("storage information");

        assert_eq!(info.incomplete_downloads.len(), 1);
        assert_eq!(
            info.incomplete_downloads[0].model_id.as_deref(),
            Some(model.id.as_str())
        );
    }

    #[test]
    fn validates_minimum_free_space() {
        assert!(ensure_free_space(MIN_MODEL_FOLDER_FREE_BYTES - 1).is_err());
        assert!(ensure_free_space(MIN_MODEL_FOLDER_FREE_BYTES).is_ok());
    }

    #[test]
    fn accepts_case_insensitive_model_file_extensions() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let info = ModelDownloadInfo {
            id: "model-q4".into(),
            family: "qwen".into(),
            file: "model.GGUF".into(),
            size_bytes: 10,
            sha256: "0".repeat(64),
            url: "https://huggingface.co/model".into(),
        };

        let spec = download_spec(temp.path(), &info).expect("case-insensitive extension");

        assert_eq!(
            spec.dest.file_name().unwrap().to_string_lossy(),
            "model.GGUF"
        );
    }

    #[tokio::test]
    async fn model_destination_rejects_traversal_components() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let info = ModelDownloadInfo {
            id: "model-q4".into(),
            family: "..".into(),
            file: "model.gguf".into(),
            size_bytes: 10,
            sha256: "0".repeat(64),
            url: "https://huggingface.co/model".into(),
        };

        let error = model_destination(temp.path(), &info)
            .await
            .expect_err("traversal component rejected");

        assert!(error.contains("invalid"));
    }
}
