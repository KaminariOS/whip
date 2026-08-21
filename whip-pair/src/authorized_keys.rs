use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use fs2::FileExt;
use ssh_key::authorized_keys::Entry;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum AppendOutcome {
    Added,
    AlreadyPresent,
}

pub fn default_authorized_keys_path() -> io::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?;
    Ok(PathBuf::from(home).join(".ssh").join("authorized_keys"))
}

pub fn append_authorized_key(path: &Path, key_line: &str) -> io::Result<AppendOutcome> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "authorized_keys has no parent")
    })?;
    if !parent.exists() {
        fs::create_dir(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }

    let mut options = OpenOptions::new();
    options
        .read(true)
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    let mut file = options.open(path)?;
    validate_target(&file)?;
    file.lock_exclusive()?;
    let result = append_locked(&mut file, key_line);
    let unlock_result = file.unlock();
    match result {
        Ok(outcome) => {
            unlock_result?;
            Ok(outcome)
        }
        Err(error) => Err(error),
    }
}

fn validate_target(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "authorized_keys is not a regular file",
        ));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "authorized_keys is not owned by the current user",
        ));
    }
    Ok(())
}

fn append_locked(file: &mut File, key_line: &str) -> io::Result<AppendOutcome> {
    let identity = key_identity(key_line)?;
    file.seek(SeekFrom::Start(0))?;
    let mut current = String::new();
    file.read_to_string(&mut current)?;
    if current
        .lines()
        .filter_map(|line| key_identity(line).ok())
        .any(|entry| entry == identity)
    {
        return Ok(AppendOutcome::AlreadyPresent);
    }
    file.seek(SeekFrom::End(0))?;
    if !current.is_empty() && !current.ends_with('\n') {
        file.write_all(b"\n")?;
    }
    file.write_all(key_line.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(AppendOutcome::Added)
}

fn key_identity(line: &str) -> io::Result<String> {
    let entry = line.parse::<Entry>().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid authorized_keys entry: {error}"),
        )
    })?;
    let mut public_key = entry.public_key().clone();
    public_key.set_comment("");
    public_key.to_openssh().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("could not encode SSH public key: {error}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const ED25519_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti";
    const ECDSA_KEY: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc=";

    #[test]
    fn appends_once_and_preserves_existing_lines() {
        let directory = tempdir().unwrap();
        let path = directory.path().join(".ssh/authorized_keys");
        let key = format!("{ED25519_KEY} prototype");
        assert_eq!(
            append_authorized_key(&path, &key).unwrap(),
            AppendOutcome::Added
        );
        assert_eq!(
            append_authorized_key(&path, &format!("{ED25519_KEY} another-comment")).unwrap(),
            AppendOutcome::AlreadyPresent
        );
        assert_eq!(fs::read_to_string(path).unwrap(), format!("{key}\n"));
    }

    #[test]
    fn detects_an_existing_non_ed25519_key_with_options() {
        let directory = tempdir().unwrap();
        let path = directory.path().join(".ssh/authorized_keys");
        fs::create_dir(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("restrict {ECDSA_KEY} existing\n")).unwrap();

        assert_eq!(
            append_authorized_key(&path, &format!("{ECDSA_KEY} pairing")).unwrap(),
            AppendOutcome::AlreadyPresent
        );
    }

    #[test]
    fn refuses_a_symlink_target() {
        use std::os::unix::fs::symlink;
        let directory = tempdir().unwrap();
        let ssh = directory.path().join(".ssh");
        fs::create_dir(&ssh).unwrap();
        let victim = directory.path().join("victim");
        fs::write(&victim, "keep\n").unwrap();
        let path = ssh.join("authorized_keys");
        symlink(&victim, &path).unwrap();
        assert!(append_authorized_key(&path, ED25519_KEY).is_err());
        assert_eq!(fs::read_to_string(victim).unwrap(), "keep\n");
    }
}
