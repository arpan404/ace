#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tag=""
previous_tag=""
output_dir="release-local"
repo="${ACE_DESKTOP_UPDATE_REPOSITORY:-}"
publish=0
skip_gates=0
skip_build=0
skip_push=0
create_tag=0
allow_dirty=0

usage() {
  printf '%s\n' \
    "Usage: bun run release:desktop:local -- --tag vX.Y.Z [options]" \
    "" \
    "Builds macOS locally and Linux/Windows in Docker, then collects release assets." \
    "" \
    "Options:" \
    "  --tag <tag>            Release tag, for example v0.2.0." \
    "  --previous-tag <tag>   Previous tag used for generated release notes." \
    "  --output-dir <dir>     Output directory relative to the repo. Default: release-local." \
    "  --repo <owner/repo>    GitHub repo for publishing. Defaults to gh repo view." \
    "  --publish             Create the GitHub release or update it if the tag already exists." \
    "  --create-tag          Create the tag at HEAD if it does not already exist." \
    "  --skip-gates          Skip bun fmt, bun lint, and bun typecheck." \
    "  --skip-build          Skip bun run build:desktop and reuse existing dist artifacts." \
    "  --skip-push           Do not push the tag before publishing." \
    "  --allow-dirty         Allow uncommitted tracked source changes." \
    "  -h, --help            Show this help."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      tag="${2:-}"
      shift 2
      ;;
    --previous-tag)
      previous_tag="${2:-}"
      shift 2
      ;;
    --output-dir)
      output_dir="${2:-}"
      shift 2
      ;;
    --repo)
      repo="${2:-}"
      shift 2
      ;;
    --publish)
      publish=1
      shift
      ;;
    --create-tag)
      create_tag=1
      shift
      ;;
    --skip-gates)
      skip_gates=1
      shift
      ;;
    --skip-build)
      skip_build=1
      shift
      ;;
    --skip-push)
      skip_push=1
      shift
      ;;
    --allow-dirty)
      allow_dirty=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    v[0-9]*)
      tag="$1"
      shift
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$tag" ]]; then
  printf 'Missing --tag.\n\n' >&2
  usage >&2
  exit 1
fi

if [[ "$output_dir" = /* || "$output_dir" = "." || "$output_dir" = ".." || "$output_dir" == ../* ]]; then
  printf 'Output directory must be a safe path relative to the repo: %s\n' "$output_dir" >&2
  exit 1
fi

version="${tag#v}"
publish_dir="$output_dir/publish"
linux_image="${ACE_DESKTOP_LINUX_DOCKER_IMAGE:-ace-desktop-linux-builder:local}"
windows_image="${ACE_DESKTOP_WINDOWS_DOCKER_IMAGE:-ace-desktop-windows-builder:local}"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

resolve_repo() {
  if [[ -n "$repo" ]]; then
    printf '%s\n' "$repo"
    return
  fi
  gh repo view --json nameWithOwner --jq '.nameWithOwner'
}

git_common_mount_args=()
resolve_git_common_mount() {
  local git_common_dir
  git_common_dir="$(git -C "$repo_root" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -z "$git_common_dir" ]]; then
    return
  fi
  if [[ "$git_common_dir" != /* ]]; then
    git_common_dir="$(cd "$repo_root/$git_common_dir" && pwd)"
  fi
  if [[ -d "$git_common_dir" ]]; then
    git_common_mount_args=(--volume "$git_common_dir:$git_common_dir:ro")
  fi
}

ensure_tag() {
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    local tag_commit
    tag_commit="$(git rev-list -n 1 "$tag")"
    local head_commit
    head_commit="$(git rev-parse HEAD)"
    if [[ "$tag_commit" != "$head_commit" ]]; then
      printf 'Tag %s points at %s, but HEAD is %s.\n' "$tag" "$tag_commit" "$head_commit" >&2
      exit 1
    fi
    return
  fi

  if [[ "$create_tag" -ne 1 ]]; then
    printf 'Tag %s does not exist. Re-run with --create-tag to tag HEAD.\n' "$tag" >&2
    exit 1
  fi

  run git tag "$tag" HEAD
}

ensure_clean_tracked_tree() {
  if [[ "$allow_dirty" -eq 1 ]]; then
    return
  fi
  if ! git diff --quiet || ! git diff --cached --quiet; then
    printf 'Tracked source changes are present. Commit them first, or pass --allow-dirty.\n' >&2
    exit 1
  fi
}

detect_previous_tag() {
  if [[ -n "$previous_tag" ]]; then
    printf '%s\n' "$previous_tag"
    return
  fi
  git describe --tags --abbrev=0 "${tag}^" 2>/dev/null || true
}

run_gates() {
  if [[ "$skip_gates" -eq 1 ]]; then
    printf '\n==> Skipping quality gates\n'
    return
  fi
  run bun fmt
  run bun lint
  run bun typecheck
}

build_shared_artifacts() {
  if [[ "$skip_build" -eq 1 ]]; then
    printf '\n==> Skipping build:desktop\n'
    return
  fi
  run bun run build:desktop
}

build_macos() {
  run bun run dist:desktop:artifact -- \
    --platform mac \
    --target dmg \
    --arch arm64 \
    --build-version "$version" \
    --output-dir "$output_dir/macos-arm64" \
    --skip-build \
    --verbose
  run bun run dist:desktop:artifact -- \
    --platform mac \
    --target dmg \
    --arch x64 \
    --build-version "$version" \
    --output-dir "$output_dir/macos-x64" \
    --skip-build \
    --verbose
}

build_linux_docker() {
  run docker build \
    --platform linux/amd64 \
    --file "$repo_root/scripts/docker/desktop-linux.Dockerfile" \
    --tag "$linux_image" \
    "$repo_root/scripts/docker"

  run docker run --rm \
    --platform linux/amd64 \
    --env ACE_DESKTOP_ARCH=x64 \
    --env ACE_DESKTOP_TARGET=AppImage \
    --env ACE_DESKTOP_OUTPUT_DIR="/workspace/$output_dir/linux-x64" \
    --env APPIMAGE_EXTRACT_AND_RUN=1 \
    --volume "$repo_root:/workspace" \
    "${git_common_mount_args[@]}" \
    --volume "ace-desktop-linux-node-modules-x64:/workspace/node_modules" \
    --volume "ace-desktop-linux-bun-cache:/root/.bun/install/cache" \
    "$linux_image" \
    bash -lc 'set -euo pipefail; git config --global --add safe.directory /workspace; bun install --ignore-scripts --frozen-lockfile; bun run dist:desktop:artifact -- --platform linux --target "$ACE_DESKTOP_TARGET" --arch "$ACE_DESKTOP_ARCH" --build-version "$1" --output-dir "$ACE_DESKTOP_OUTPUT_DIR" --skip-build --verbose' \
    bash \
    "$version"

  run docker run --rm \
    --platform linux/amd64 \
    --env ACE_DESKTOP_ARCH=arm64 \
    --env ACE_DESKTOP_TARGET=AppImage \
    --env ACE_DESKTOP_OUTPUT_DIR="/workspace/$output_dir/linux-arm64" \
    --env APPIMAGE_EXTRACT_AND_RUN=1 \
    --volume "$repo_root:/workspace" \
    "${git_common_mount_args[@]}" \
    --volume "ace-desktop-linux-node-modules-arm64:/workspace/node_modules" \
    --volume "ace-desktop-linux-bun-cache:/root/.bun/install/cache" \
    "$linux_image" \
    bash -lc 'set -euo pipefail; git config --global --add safe.directory /workspace; bun install --ignore-scripts --frozen-lockfile; bun run dist:desktop:artifact -- --platform linux --target "$ACE_DESKTOP_TARGET" --arch "$ACE_DESKTOP_ARCH" --build-version "$1" --output-dir "$ACE_DESKTOP_OUTPUT_DIR" --skip-build --verbose' \
    bash \
    "$version"
}

build_windows_docker() {
  run docker build \
    --platform linux/amd64 \
    --file "$repo_root/scripts/docker/desktop-windows.Dockerfile" \
    --tag "$windows_image" \
    "$repo_root/scripts/docker"

  run docker run --rm \
    --platform linux/amd64 \
    --env ACE_DESKTOP_ARCH=x64 \
    --env ACE_DESKTOP_OUTPUT_DIR="/workspace/$output_dir/windows-x64" \
    --env CSC_IDENTITY_AUTO_DISCOVERY=false \
    --volume "$repo_root:/workspace" \
    "${git_common_mount_args[@]}" \
    --volume "ace-desktop-windows-node-modules-x64:/workspace/node_modules" \
    --volume "ace-desktop-windows-bun-cache:/root/.bun/install/cache" \
    "$windows_image" \
    bash -lc 'set -euo pipefail; git config --global --add safe.directory /workspace; cd /workspace; bun install --ignore-scripts --frozen-lockfile; bun run dist:desktop:artifact -- --platform win --target nsis --arch "$ACE_DESKTOP_ARCH" --build-version "$1" --output-dir "$ACE_DESKTOP_OUTPUT_DIR" --skip-build --verbose' \
    bash \
    "$version"

  run docker run --rm \
    --platform linux/amd64 \
    --env ACE_DESKTOP_ARCH=arm64 \
    --env ACE_DESKTOP_OUTPUT_DIR="/workspace/$output_dir/windows-arm64" \
    --env CSC_IDENTITY_AUTO_DISCOVERY=false \
    --volume "$repo_root:/workspace" \
    "${git_common_mount_args[@]}" \
    --volume "ace-desktop-windows-node-modules-arm64:/workspace/node_modules" \
    --volume "ace-desktop-windows-bun-cache:/root/.bun/install/cache" \
    "$windows_image" \
    bash -lc 'set -euo pipefail; git config --global --add safe.directory /workspace; cd /workspace; bun install --ignore-scripts --frozen-lockfile; bun run dist:desktop:artifact -- --platform win --target nsis --arch "$ACE_DESKTOP_ARCH" --build-version "$1" --output-dir "$ACE_DESKTOP_OUTPUT_DIR" --skip-build --verbose' \
    bash \
    "$version"
}

collect_assets() {
  run rm -rf "$publish_dir"
  run mkdir -p "$publish_dir"

  cp "$output_dir"/macos-arm64/* "$publish_dir"/
  for file in "$output_dir"/macos-x64/*; do
    local base
    base="$(basename "$file")"
    if [[ "$base" = "latest-mac.yml" ]]; then
      cp "$file" "$publish_dir/latest-mac-x64.yml"
    else
      cp "$file" "$publish_dir"/
    fi
  done
  for file in "$output_dir"/linux-x64/*; do
    cp "$file" "$publish_dir"/
  done
  for file in "$output_dir"/linux-arm64/*; do
    local base
    base="$(basename "$file")"
    if [[ "$base" = "latest-linux.yml" ]]; then
      cp "$file" "$publish_dir/latest-linux-arm64.yml"
    else
      cp "$file" "$publish_dir"/
    fi
  done
  for file in "$output_dir"/windows-x64/*; do
    cp "$file" "$publish_dir"/
  done
  for file in "$output_dir"/windows-arm64/*; do
    local base
    base="$(basename "$file")"
    if [[ "$base" = "latest.yml" ]]; then
      cp "$file" "$publish_dir/latest-arm64.yml"
    else
      cp "$file" "$publish_dir"/
    fi
  done
  node scripts/merge-mac-update-manifests.ts \
    "$publish_dir/latest-mac.yml" \
    "$publish_dir/latest-mac-x64.yml"
  node scripts/merge-windows-update-manifests.ts \
    "$publish_dir/latest.yml" \
    "$publish_dir/latest-arm64.yml"
  rm -f "$publish_dir/latest-mac-x64.yml" "$publish_dir/latest-arm64.yml" "$publish_dir/builder-debug.yml"

  run find "$publish_dir" -maxdepth 1 -type f -print
  run shasum -a 256 "$publish_dir"/*
}

write_release_notes() {
  local notes_file="$1"
  local base_tag="$2"

  {
    printf "## What's Changed\n\n"

    if [[ -n "$base_tag" ]]; then
      while IFS=$'\t' read -r subject; do
        [[ -z "$subject" ]] && continue
        local pr_number
        pr_number="$(sed -nE 's/^Merge pull request #([0-9]+).*/\1/p' <<<"$subject")"
        [[ -z "$pr_number" ]] && continue
        gh pr view "$pr_number" --repo "$repo" --json title,author,url \
          --jq '"- \(.title) by @\(.author.login) in \(.url)"'
      done < <(git log --first-parent --merges --format='%s' "$base_tag..$tag")
    fi

    printf "\n## Release Preparation\n\n"
    if [[ -n "$base_tag" ]]; then
      git log --first-parent --no-merges --format='- %s by %an in https://github.com/%H' "$base_tag..$tag" \
        | sed "s#https://github.com/#https://github.com/$repo/commit/#"
    fi

    if [[ -n "$base_tag" ]]; then
      printf "\n**Full Changelog**: https://github.com/%s/compare/%s...%s\n" "$repo" "$base_tag" "$tag"
    fi
  } >"$notes_file"
}

publish_release() {
  if [[ "$publish" -ne 1 ]]; then
    printf '\n==> Skipping GitHub release creation. Re-run with --publish to upload %s.\n' "$publish_dir"
    return
  fi

  repo="$(resolve_repo)"
  if [[ "$skip_push" -ne 1 ]]; then
    run git push origin "$tag"
  fi

  local base_tag
  base_tag="$(detect_previous_tag)"
  local notes_file
  notes_file="$(mktemp)"
  write_release_notes "$notes_file" "$base_tag"

  local release_flags=(--repo "$repo" --title "ace $tag" --notes-file "$notes_file" --verify-tag)
  if [[ "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    release_flags+=(--latest)
  else
    release_flags+=(--prerelease)
  fi

  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    local edit_flags=(--repo "$repo" --title "ace $tag" --notes-file "$notes_file")
    if [[ "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      edit_flags+=(--latest)
    else
      edit_flags+=(--prerelease)
    fi
    run gh release edit "$tag" "${edit_flags[@]}"
    run gh release upload "$tag" "$publish_dir"/* --repo "$repo" --clobber
  else
    run gh release create "$tag" "$publish_dir"/* "${release_flags[@]}"
  fi
  rm -f "$notes_file"
}

require_command bun
require_command docker
require_command git
require_command gh

ensure_clean_tracked_tree
ensure_tag
resolve_git_common_mount
run_gates
build_shared_artifacts
run rm -rf "$output_dir"
build_macos
build_linux_docker
build_windows_docker
collect_assets
publish_release
