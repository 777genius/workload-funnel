#!/bin/sh
set -eu

state_file=/tmp/workload-funnel-azurite-supervisor.state
generation=0
server_pid=0
restart_requested=false
stop_requested=false
kill_timer_pid=0

account_key="$(cat /run/secrets/azurite-account-key)"
case "$account_key" in
  "" | *[!A-Za-z0-9+/=]*) exit 64 ;;
esac
if [ "${#account_key}" -lt 32 ] || [ "${#account_key}" -gt 128 ]; then
  exit 64
fi

write_state() {
  temporary_state="${state_file}.next"
  (
    umask 077
    /usr/bin/printf 'workload-funnel.azurite-supervisor.v1|%s|%s|%s\n' \
      "$$" "$generation" "$server_pid" > "$temporary_state"
  )
  /bin/mv "$temporary_state" "$state_file"
}

stop_server() {
  signal=$1
  if [ "$server_pid" -gt 1 ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "-$signal" "$server_pid" 2>/dev/null || true
    (
      trap - USR1 TERM INT
      /bin/sleep 5
      kill -KILL "$server_pid" 2>/dev/null || true
    ) &
    kill_timer_pid=$!
  fi
}

request_restart() {
  restart_requested=true
}

request_stop() {
  stop_requested=true
}

trap request_restart USR1
trap request_stop TERM INT

while [ "$stop_requested" = false ]; do
  generation=$((generation + 1))
  AZURITE_ACCOUNTS="wfaccount:$account_key" \
    /usr/local/bin/azurite-blob \
      --blobHost 0.0.0.0 \
      --blobPort 10000 \
      --location /data \
      --silent \
      --disableTelemetry &
  server_pid=$!
  write_state

  while true; do
    if { [ "$restart_requested" = true ] || [ "$stop_requested" = true ]; } &&
      [ "$kill_timer_pid" -eq 0 ]; then
      stop_server TERM
    fi
    if wait "$server_pid"; then
      server_status=0
      break
    else
      server_status=$?
      if kill -0 "$server_pid" 2>/dev/null; then
        continue
      fi
      break
    fi
  done

  if [ "$kill_timer_pid" -gt 1 ]; then
    kill -TERM "$kill_timer_pid" 2>/dev/null || true
    wait "$kill_timer_pid" 2>/dev/null || true
    kill_timer_pid=0
  fi
  if [ "$stop_requested" = true ]; then
    /bin/rm -f "$state_file" "${state_file}.next"
    exit "$server_status"
  fi
  if [ "$restart_requested" = true ]; then
    restart_requested=false
    continue
  fi
  /bin/rm -f "$state_file" "${state_file}.next"
  exit "$server_status"
done
