//! Remote path resolution, preview ownership, transfer progress, and Git execution.

use super::*;

pub(super) async fn resolved_remote_path(
    inner: &RuntimeInner,
    path: Option<&str>,
) -> Result<String, HostRuntimeError> {
    let generation = current_generation(inner)?;
    let home = current_ssh(inner)?.remote_home().await?;
    validate_generation(inner, generation)?;
    let home = crate::remote_ops::normalize_absolute(home.trim())
        .map_err(HostRuntimeError::RemoteFileFailure)?;
    normalize_remote_path(path, &home).map_err(HostRuntimeError::RemoteFileFailure)
}

pub(super) fn update_transfer_progress(
    inner: &Arc<RuntimeInner>,
    transfer_id: &str,
    bytes_transferred: u64,
    total_bytes: Option<u64>,
) {
    let progress = {
        let mut transfers = inner.operations.transfers.lock();
        let Some(slot) = transfers.get_mut(transfer_id) else {
            return;
        };
        if !matches!(
            slot.progress.state,
            TransferState::Pending | TransferState::Running
        ) {
            return;
        }
        slot.progress.state = TransferState::Running;
        slot.progress.bytes_transferred = slot.progress.bytes_transferred.max(bytes_transferred);
        slot.progress.total_bytes = total_bytes;
        slot.progress.clone()
    };
    emit(HostRuntimeEvent::TransferProgressChanged {
        runtime_id: inner.id.clone(),
        progress,
    });
}

pub(super) fn finish_transfer(
    inner: &Arc<RuntimeInner>,
    transfer_id: &str,
    generation: u64,
    result: Result<TransferResult, String>,
) {
    let current_generation = inner.state.lock().generation;
    let connected = inner.state.lock().connection == HostConnectionState::Connected;
    let (progress, notify) = {
        let mut transfers = inner.operations.transfers.lock();
        let Some(slot) = transfers.get_mut(transfer_id) else {
            return;
        };
        if matches!(
            slot.progress.state,
            TransferState::Completed | TransferState::Failed
        ) {
            return;
        }
        if slot.progress.state == TransferState::Cancelled {
            slot.result = Some(Err("transfer cancelled".to_owned()));
        } else if slot.generation != generation || current_generation != generation || !connected {
            slot.progress.state = TransferState::Failed;
            slot.result = Some(Err("host connection changed during transfer".to_owned()));
        } else {
            slot.progress.state = if result.is_ok() {
                TransferState::Completed
            } else {
                TransferState::Failed
            };
            slot.result = Some(result);
        }
        (slot.progress.clone(), slot.notify.clone())
    };
    emit(HostRuntimeEvent::TransferProgressChanged {
        runtime_id: inner.id.clone(),
        progress,
    });
    notify.notify_one();
}

pub(super) fn invalidate_remote_operations(
    inner: &Arc<RuntimeInner>,
    generation: u64,
    reason: &str,
) {
    inner.operations.cancel_generation(generation, reason);
    let previews = inner.operations.disconnect_previews(generation);
    for (preview_id, _) in &previews {
        emit(HostRuntimeEvent::PreviewStateChanged {
            runtime_id: inner.id.clone(),
            preview_id: preview_id.clone(),
            state: PreviewState::Disconnected,
            error: Some(reason.to_owned()),
        });
    }
    let ssh = inner.ssh.read().clone();
    if let (Some(ssh), Ok(runtime)) = (ssh, crate::runtime()) {
        runtime.spawn(async move {
            for (_, preview) in previews {
                crate::remote_preview::stop_preview(&ssh, preview.resource).await;
            }
        });
    }
}

pub(super) fn register_preview(
    inner: &RuntimeInner,
    id: String,
    generation: u64,
    preview: crate::remote_ops::ManagedPreview,
) -> Result<(), Box<(HostRuntimeError, crate::remote_ops::ManagedPreview)>> {
    let state = inner.state.lock();
    if state.connection != HostConnectionState::Connected || state.generation != generation {
        return Err(Box::new((
            HostRuntimeError::StaleOperation(
                "preview opened after its host connection was replaced".to_owned(),
            ),
            preview,
        )));
    }
    let mut previews = inner.operations.previews.lock();
    if previews.len() >= MAX_ACTIVE_PREVIEWS {
        return Err(Box::new((
            HostRuntimeError::PreviewFailure(format!(
                "at most {MAX_ACTIVE_PREVIEWS} previews may be open at once"
            )),
            preview,
        )));
    }
    previews.insert(id, preview);
    Ok(())
}

pub(super) async fn start_path_preview_inner(
    inner: Arc<RuntimeInner>,
    remote_path: String,
    html: bool,
) -> Result<PreviewInfo, HostRuntimeError> {
    if inner.operations.previews.lock().len() >= MAX_ACTIVE_PREVIEWS {
        return Err(HostRuntimeError::PreviewFailure(format!(
            "at most {MAX_ACTIVE_PREVIEWS} previews may be open at once"
        )));
    }
    let generation = current_generation(&inner)?;
    let remote_path = resolved_remote_path(&inner, Some(&remote_path)).await?;
    let id = inner.operations.next_id("preview");
    let ssh = current_ssh(&inner)?;
    let (info, preview) = if html {
        crate::remote_preview::start_html_preview(ssh.clone(), id.clone(), generation, &remote_path)
            .await?
    } else {
        crate::remote_preview::start_remote_file_preview(
            ssh.clone(),
            id.clone(),
            generation,
            &remote_path,
        )
        .await?
    };
    if let Err(error_preview) = register_preview(&inner, id, generation, preview) {
        let (error, preview) = *error_preview;
        crate::remote_preview::stop_preview(&ssh, preview.resource).await;
        return Err(error);
    }
    Ok(info)
}

pub(super) async fn transfer_setup_step<T, E, F>(
    cancel: &mut watch::Receiver<bool>,
    future: F,
) -> Result<T, String>
where
    E: std::fmt::Display,
    F: std::future::Future<Output = Result<T, E>>,
{
    if *cancel.borrow() {
        return Err("transfer cancelled".to_owned());
    }
    tokio::select! {
        biased;
        changed = cancel.changed() => {
            let _ = changed;
            Err("transfer cancelled".to_owned())
        }
        result = future => result.map_err(|error| error.to_string()),
    }
}

pub(super) async fn execute_generation_checked(
    inner: &RuntimeInner,
    command: &str,
) -> Result<crate::ssh::CommandOutput, HostRuntimeError> {
    const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
    let generation = current_generation(inner)?;
    let output = tokio::time::timeout(GIT_COMMAND_TIMEOUT, current_ssh(inner)?.execute(command))
        .await
        .map_err(|_| {
            HostRuntimeError::GitFailure(
                "remote Git operation timed out after 30 seconds".to_owned(),
            )
        })??;
    validate_generation(inner, generation)?;
    Ok(output)
}

pub(super) fn command_failure(kind: &str, output: &crate::ssh::CommandOutput) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.lines().take(3).collect::<Vec<_>>().join("\n");
    if detail.is_empty() {
        format!(
            "{kind} exited with status {}",
            output
                .exit_status
                .map_or_else(|| "unknown".to_owned(), |value| value.to_string())
        )
    } else {
        format!("{kind} failed: {detail}")
    }
}
