export const SYSTEMD_OBSERVATION_WINDOW_TIMEOUT_MS = 10_000;

export function exactSystemdObservationWindowInput(marker, timeoutMs) {
  return (
    /^\/var\/lib\/workload-funnel\/allocations\/wf-production-gate-[a-f0-9]{32}\/\.observed-[a-z0-9-]{1,24}$/u.test(
      marker ?? "",
    ) && timeoutMs === SYSTEMD_OBSERVATION_WINDOW_TIMEOUT_MS
  );
}
