#!/bin/sh
# Keeps the sniper running: restarts it if it crashes, stops on a clean exit
# (Ctrl+C or menu option 0). Jobs are restored from state.json on every start.
cd "$(dirname "$0")" || exit 1
until node --env-file=.env sniper.js; do
  echo "sniper stopped unexpectedly — restarting in 3s (Ctrl+C to cancel)"
  sleep 3
done
