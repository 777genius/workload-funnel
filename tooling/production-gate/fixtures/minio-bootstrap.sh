#!/bin/sh
set -eu

operation=$1
shift
export MC_CONFIG_DIR=/gate/mc

case "$operation" in
  ready)
    exec /usr/bin/mc ready gate
    ;;
  make-bucket)
    exec /usr/bin/mc mb --ignore-existing "gate/$1"
    ;;
  create-policy)
    exec /usr/bin/mc admin policy create gate "$1" /gate/policy.json
    ;;
  add-user)
    /bin/cat "$1" | /usr/bin/mc admin user add gate
    ;;
  attach-policy)
    exec /usr/bin/mc admin policy attach gate "$1" --user "$2"
    ;;
  *)
    exit 64
    ;;
esac
