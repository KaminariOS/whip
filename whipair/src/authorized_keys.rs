use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use fs2::FileExt;
use ssh_key::PublicKey;

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
    ensure_parent(path)?;
    let lock = acquire_mutation_lock(path)?;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    let mut file = options.open(path)?;
    validate_target(&file)?;
    let result = append_locked(&mut file, key_line);
    let unlock_result = FileExt::unlock(&lock);
    match result {
        Ok(outcome) => {
            unlock_result?;
            Ok(outcome)
        }
        Err(error) => Err(error),
    }
}

pub fn remove_authorized_key(path: &Path, key_line: &str) -> io::Result<bool> {
    let identity = key_identity(key_line)?;
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "authorized_keys has no parent")
    })?;
    let lock = acquire_mutation_lock(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    validate_target(&file)?;

    let mut current = String::new();
    file.read_to_string(&mut current)?;
    let mut removed = false;
    let mut retained = String::with_capacity(current.len());
    for line in current.split_inclusive('\n') {
        let candidate = line
            .strip_suffix('\n')
            .unwrap_or(line)
            .trim_end_matches('\r');
        if key_identity(candidate).is_ok_and(|candidate| candidate == identity) {
            removed = true;
        } else {
            retained.push_str(line);
        }
    }
    if !removed {
        FileExt::unlock(&lock)?;
        return Ok(false);
    }

    let permissions = file.metadata()?.permissions();
    let mut replacement = tempfile::NamedTempFile::new_in(parent)?;
    replacement.as_file_mut().set_permissions(permissions)?;
    replacement.write_all(retained.as_bytes())?;
    replacement.as_file_mut().sync_all()?;
    replacement.persist(path).map_err(|error| error.error)?;
    File::open(parent)?.sync_all()?;
    FileExt::unlock(&lock)?;
    Ok(true)
}

fn ensure_parent(path: &Path) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "authorized_keys has no parent")
    })?;
    if !parent.exists() {
        fs::create_dir(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn mutation_lock_path(path: &Path) -> io::Result<PathBuf> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "authorized_keys has no parent")
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "authorized_keys has no file name",
        )
    })?;
    let mut lock_name = OsString::from(".");
    lock_name.push(file_name);
    lock_name.push(".lock");
    Ok(parent.join(lock_name))
}

fn acquire_mutation_lock(path: &Path) -> io::Result<File> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(mutation_lock_path(path)?)?;
    validate_target(&lock)?;
    lock.lock_exclusive()?;
    Ok(lock)
}

fn validate_target(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "authorized_keys is not a regular file",
        ));
    }
    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    let effective_user_id = unsafe { libc::geteuid() };
    if metadata.uid() != effective_user_id {
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
    let trimmed = line.trim();
    let public_key = PublicKey::from_openssh(trimmed)
        .or_else(|_| {
            let key_start = options_end(trimmed).ok_or(ssh_key::Error::FormatEncoding)?;
            PublicKey::from_openssh(trimmed[key_start..].trim_start())
        })
        .map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid authorized_keys entry: {error}"),
            )
        })?;
    let mut public_key = public_key;
    public_key.set_comment("");
    public_key.to_openssh().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("could not encode SSH public key: {error}"),
        )
    })
}

fn options_end(line: &str) -> Option<usize> {
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            character if character.is_whitespace() && !quoted => return Some(index),
            _ => {}
        }
    }
    None
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

    #[test]
    fn removes_only_the_matching_temporary_key() {
        let directory = tempdir().unwrap();
        let path = directory.path().join(".ssh/authorized_keys");
        fs::create_dir(path.parent().unwrap()).unwrap();
        let temporary = format!("restrict,command=\"whipair exchange\" {ED25519_KEY} temporary");
        fs::write(
            &path,
            format!("# keep this comment\n{temporary}\n{ECDSA_KEY} permanent\n"),
        )
        .unwrap();

        assert!(remove_authorized_key(&path, &temporary).unwrap());
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            format!("# keep this comment\n{ECDSA_KEY} permanent\n")
        );
    }

    #[test]
    fn keeps_one_stable_lock_file_across_target_replacements() {
        let directory = tempdir().unwrap();
        let path = directory.path().join(".ssh/authorized_keys");
        let temporary = format!("{ED25519_KEY} temporary");
        append_authorized_key(&path, &temporary).unwrap();
        let lock_path = mutation_lock_path(&path).unwrap();
        let original_lock_inode = fs::metadata(&lock_path).unwrap().ino();

        remove_authorized_key(&path, &temporary).unwrap();
        append_authorized_key(&path, ECDSA_KEY).unwrap();

        assert_eq!(fs::metadata(lock_path).unwrap().ino(), original_lock_inode);
    }

    #[test]
    fn parses_forced_commands_with_spaces_and_quotes() {
        let line = format!(
            "restrict,command=\"'/nix/store/whip pair' exchange --socket '/tmp/pair socket'\" {ED25519_KEY} temporary"
        );
        assert!(key_identity(&line).is_ok());
    }
}
