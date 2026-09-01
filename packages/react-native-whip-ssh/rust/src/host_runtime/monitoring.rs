//! Foreground-aware health, latency, and reconciliation policy.

use super::*;
use std::time::Instant;

const MONITOR_TICK: Duration = Duration::from_secs(1);
const HEALTH_INTERVAL: Duration = Duration::from_secs(15);
const RECONCILE_INTERVAL: Duration = Duration::from_secs(120);
const VISIBLE_LATENCY_INTERVAL: Duration = Duration::from_secs(3);
const RECOVERY_FAILURE_THRESHOLD: u32 = 3;

#[derive(Debug, Default)]
pub(super) struct MonitoringState {
    pub(super) app_active: bool,
    pub(super) hosts_visible: bool,
    pub(super) access_locked: bool,
    worker_running: bool,
    latency_failures: u32,
}

pub(super) fn set_monitoring_state(
    inner: &Arc<RuntimeInner>,
    app_active: bool,
    hosts_visible: bool,
    access_locked: bool,
) {
    let (start_worker, became_active) = {
        let mut monitoring = inner.monitoring.lock();
        let became_active = app_active && !monitoring.app_active;
        monitoring.app_active = app_active;
        monitoring.hosts_visible = hosts_visible;
        monitoring.access_locked = access_locked;
        let start_worker = if monitoring.worker_running {
            false
        } else {
            monitoring.worker_running = true;
            true
        };
        drop(monitoring);
        (start_worker, became_active)
    };
    inner.monitoring_changed.notify_waiters();
    if became_active {
        inner.reconnect_wakeup.notify_one();
    }
    if !start_worker {
        return;
    }
    let weak = Arc::downgrade(inner);
    let changed = inner.monitoring_changed.clone();
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let now = Instant::now();
            let mut last_health = now.checked_sub(HEALTH_INTERVAL).unwrap_or(now);
            let mut last_reconcile = now.checked_sub(RECONCILE_INTERVAL).unwrap_or(now);
            let mut last_visible_latency = now.checked_sub(VISIBLE_LATENCY_INTERVAL).unwrap_or(now);
            loop {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let active = inner.monitoring.lock().app_active;
                drop(inner);
                if !active {
                    changed.notified().await;
                    continue;
                }
                tokio::select! {
                    () = tokio::time::sleep(MONITOR_TICK) => {}
                    () = changed.notified() => {}
                }
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let (active, visible) = {
                    let monitoring = inner.monitoring.lock();
                    (
                        monitoring.app_active,
                        monitoring.hosts_visible && !monitoring.access_locked,
                    )
                };
                if !active {
                    continue;
                }
                let health_due = last_health.elapsed() >= HEALTH_INTERVAL;
                let visible_latency_due =
                    visible && last_visible_latency.elapsed() >= VISIBLE_LATENCY_INTERVAL;
                if visible_latency_due || health_due {
                    if visible_latency_due {
                        last_visible_latency = Instant::now();
                    }
                    if health_due {
                        last_health = Instant::now();
                    }
                    probe(inner.clone()).await;
                }
                let reconcile_due = last_reconcile.elapsed() >= RECONCILE_INTERVAL;
                let needs_reconcile = {
                    let state = inner.state.lock();
                    state.connection == HostConnectionState::Connected
                        && (reconcile_due
                            || (health_due
                                && (state.host_state.projection().needs_resync
                                    || state.host_state.projection().freshness
                                        != crate::host_state::HostFreshness::Fresh)))
                };
                if needs_reconcile {
                    if reconcile_due {
                        last_reconcile = Instant::now();
                    }
                    let _ = refresh_host_state_inner(inner).await;
                }
            }
        });
    } else {
        inner.monitoring.lock().worker_running = false;
    }
}

async fn probe(inner: Arc<RuntimeInner>) {
    if inner.state.lock().connection != HostConnectionState::Connected {
        return;
    }
    match measure_host_latency_inner(inner.clone()).await {
        Ok(measurement) => {
            inner.monitoring.lock().latency_failures = 0;
            emit(HostRuntimeEvent::LatencyMeasured {
                runtime_id: inner.id.clone(),
                measurement,
            });
        }
        Err(error) => {
            let failures = {
                let mut monitoring = inner.monitoring.lock();
                monitoring.latency_failures = monitoring.latency_failures.saturating_add(1);
                monitoring.latency_failures
            };
            if failures >= RECOVERY_FAILURE_THRESHOLD {
                inner.monitoring.lock().latency_failures = 0;
                begin_reconnect(
                    inner,
                    format!("host health check failed {failures} times: {error}"),
                    true,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitoring_defaults_to_background_without_polling() {
        let state = MonitoringState::default();
        assert!(!state.app_active);
        assert!(!state.hosts_visible);
        assert_eq!(state.latency_failures, 0);
    }
}
