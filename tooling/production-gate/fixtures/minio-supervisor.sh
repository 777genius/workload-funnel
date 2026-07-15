#!/bin/sh
set -eu

state_file=/tmp/workload-funnel-minio-supervisor.state
expected_root_user_file=/run/secrets/minio-root-user
expected_root_password_file=/run/secrets/minio-root-password
generation=0
server_pid=0
restart_requested=false
stop_requested=false
kill_timer_pid=0

if [ "${MINIO_ROOT_USER_FILE-}" != "$expected_root_user_file" ] ||
  [ "${MINIO_ROOT_PASSWORD_FILE-}" != "$expected_root_password_file" ] ||
  [ ! -f "$expected_root_user_file" ] ||
  [ -L "$expected_root_user_file" ] ||
  [ ! -r "$expected_root_user_file" ] ||
  [ ! -f "$expected_root_password_file" ] ||
  [ -L "$expected_root_password_file" ] ||
  [ ! -r "$expected_root_password_file" ]; then
  exit 70
fi

root_user=
extra=
exec 3< "$expected_root_user_file"
if ! IFS= read -r root_user <&3; then
  exit 70
fi
if IFS= read -r extra <&3 || [ -n "$extra" ]; then
  exit 70
fi
exec 3<&-

root_password=
extra=
exec 3< "$expected_root_password_file"
if ! IFS= read -r root_password <&3; then
  exit 70
fi
if IFS= read -r extra <&3 || [ -n "$extra" ]; then
  exit 70
fi
exec 3<&-

case "$root_user" in
  "" | *[!A-Za-z0-9_-]*) exit 70 ;;
esac
case "$root_password" in
  "" | *[!A-Za-z0-9_-]*) exit 70 ;;
esac
if [ "${#root_user}" -lt 3 ] || [ "${#root_user}" -gt 64 ] ||
  [ "${#root_password}" -lt 8 ] || [ "${#root_password}" -gt 128 ]; then
  exit 70
fi
unset MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE extra

write_state() {
  temporary_state="${state_file}.next"
  (
    umask 077
    /usr/bin/printf 'workload-funnel.minio-supervisor.v1|%s|%s|%s\n' \
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
  MINIO_ROOT_USER="$root_user" MINIO_ROOT_PASSWORD="$root_password" \
    /usr/bin/minio "$@" &
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
