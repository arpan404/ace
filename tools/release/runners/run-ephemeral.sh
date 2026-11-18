#!/bin/sh
# Runs one GitHub Actions runner for ace's release pipeline as ephemeral runners, one after
# another (ADR 0188): each registers, takes exactly one job, is removed by GitHub, and its work
# folder is deleted before the next registers. Runs as the ace-ci user, under systemd on
# omarchy and launchd on the Mac (docs/release/runners.md).
#
#   run-ephemeral.sh <runner folder> <name> <labels>
#
# The runner folder holds an unpacked actions/runner release. The registration token comes from
# GitHub's API with the fine-grained token in $ACE_RUNNER_TOKEN_FILE (repository
# Administration: read and write, arpan404/ace only).
set -eu
dir=${1:?usage: run-ephemeral.sh <runner folder> <name> <labels>}
name=${2:?name}
labels=${3:?labels}
token_file=${ACE_RUNNER_TOKEN_FILE:-$HOME/.config/ace-runner/token}
repo=arpan404/ace

cd "$dir"
while :; do
  rm -rf _work .runner .credentials .credentials_rsaparams
  registration=$(curl --fail --silent --show-error --proto '=https' -X POST \
    -H "Authorization: Bearer $(cat "$token_file")" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$repo/actions/runners/registration-token" |
    sed -n 's/.*"token": *"\([^"]*\)".*/\1/p')
  if [ -z "$registration" ]; then
    echo "Couldn't get a registration token; retrying in 60s" >&2
    sleep 60
    continue
  fi
  ./config.sh --unattended --ephemeral --replace --disableupdate \
    --url "https://github.com/$repo" --token "$registration" \
    --name "$name" --labels "$labels" --work _work
  # Exits after its one job; a crash or a lost connection just starts a fresh runner.
  ./run.sh || sleep 10
done
