use std::{
    fs,
    io::{self, Read},
    path::Path,
};

pub struct ExtractLimits {
    pub max_files: usize,
    pub max_total_bytes: u64,
}

pub const RUNTIME_LIMITS: ExtractLimits = ExtractLimits {
    max_files: 2_000,
    max_total_bytes: 4 * 1024 * 1024 * 1024,
};

pub fn extract_zip_safely(
    zip_path: &Path,
    dest: &Path,
    limits: &ExtractLimits,
) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("not a valid zip: {e}"))?;
    if archive.len() > limits.max_files {
        return Err("archive has too many files".into());
    }
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| "archive contains an unsafe path".to_string())?;
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        let size = entry.size();
        total = total.saturating_add(size);
        if total > limits.max_total_bytes {
            return Err("archive is too large when unpacked".into());
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut f = fs::File::create(&out).map_err(|e| e.to_string())?;
        let copied = io::copy(&mut (&mut entry).take(size), &mut f).map_err(|e| e.to_string())?;
        if copied != size {
            return Err("archive entry is truncated".into());
        }
        let mut extra = [0; 1];
        if entry
            .read(&mut extra)
            .map_err(|error| format!("could not validate archive entry: {error}"))?
            != 0
        {
            return Err("archive entry exceeds its declared size".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut w = ZipWriter::new(fs::File::create(path).unwrap());
        for (name, data) in entries {
            w.start_file(*name, SimpleFileOptions::default()).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn extracts_normal_files() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("a.zip");
        make_zip(&z, &[("llama-server.exe", b"x"), ("sub/dll.dll", b"y")]);
        let out = d.path().join("out");
        extract_zip_safely(&z, &out, &RUNTIME_LIMITS).unwrap();
        assert!(out.join("llama-server.exe").exists());
        assert!(out.join("sub/dll.dll").exists());
    }

    #[test]
    fn extracts_directory_entries() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("directory.zip");
        let mut writer = ZipWriter::new(fs::File::create(&z).unwrap());
        writer
            .add_directory("folder/", SimpleFileOptions::default())
            .unwrap();
        writer
            .start_file("folder/file.txt", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"contents").unwrap();
        writer.finish().unwrap();

        let out = d.path().join("out");
        extract_zip_safely(&z, &out, &RUNTIME_LIMITS).unwrap();
        assert!(out.join("folder").is_dir());
        assert_eq!(fs::read(out.join("folder/file.txt")).unwrap(), b"contents");
    }

    #[test]
    fn rejects_bad_crc_after_extracting_a_previous_entry() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("bad-crc.zip");
        make_zip(&z, &[("first.txt", b"first"), ("second.txt", b"second")]);
        let mut bytes = fs::read(&z).unwrap();
        let central_header = bytes
            .windows(4)
            .rposition(|window| window == b"PK\x01\x02")
            .unwrap();
        bytes[central_header + 16] ^= 0xff;
        fs::write(&z, bytes).unwrap();

        let out = d.path().join("out");
        assert!(extract_zip_safely(&z, &out, &RUNTIME_LIMITS).is_err());
        assert_eq!(fs::read(out.join("first.txt")).unwrap(), b"first");
    }

    #[test]
    fn rejects_an_entry_shorter_than_its_declared_size_after_partial_extraction() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("truncated.zip");
        make_zip(&z, &[("first.txt", b"first"), ("second.txt", b"second")]);
        let mut bytes = fs::read(&z).unwrap();
        let central_headers = bytes
            .windows(4)
            .enumerate()
            .filter_map(|(index, window)| (window == b"PK\x01\x02").then_some(index))
            .collect::<Vec<_>>();
        let second_header = *central_headers.last().unwrap();
        let declared_size = u32::from_le_bytes(
            bytes[second_header + 24..second_header + 28]
                .try_into()
                .unwrap(),
        );
        bytes[second_header + 24..second_header + 28]
            .copy_from_slice(&(declared_size + 1).to_le_bytes());
        fs::write(&z, bytes).unwrap();

        let out = d.path().join("out");
        assert!(extract_zip_safely(&z, &out, &RUNTIME_LIMITS).is_err());
        assert_eq!(fs::read(out.join("first.txt")).unwrap(), b"first");
    }

    #[test]
    fn rejects_zip_slip() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("evil.zip");
        make_zip(&z, &[("../evil.txt", b"x")]);
        let out = d.path().join("out");
        assert!(extract_zip_safely(&z, &out, &RUNTIME_LIMITS).is_err());
        assert!(!d.path().join("evil.txt").exists());
    }

    #[test]
    fn enforces_limits() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("a.zip");
        make_zip(&z, &[("a", b"12345"), ("b", b"12345")]);
        let tiny = ExtractLimits {
            max_files: 1,
            max_total_bytes: 1 << 30,
        };
        assert!(extract_zip_safely(&z, &d.path().join("o1"), &tiny).is_err());
        let small = ExtractLimits {
            max_files: 10,
            max_total_bytes: 6,
        };
        assert!(extract_zip_safely(&z, &d.path().join("o2"), &small).is_err());
    }
}
