#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${VERIFY_CONTAINER_IMAGE:-docker.io/library/ubuntu:24.04}"
RUNTIME="${CONTAINER_RUNTIME:-}"

if [ -z "${RUNTIME}" ]; then
  if command -v podman >/dev/null 2>&1; then
    RUNTIME="podman"
  elif command -v docker >/dev/null 2>&1; then
    RUNTIME="docker"
  else
    echo "No container runtime found. Install podman or docker." >&2
    exit 1
  fi
fi

TMP_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/deploy-setup-patch.XXXXXX.sh")"
cleanup() {
  rm -f "${TMP_SCRIPT}"
}
trap cleanup EXIT

node -e "const fs=require('fs');const {renderServerPatchScript}=require('./dist/core/patcher');fs.writeFileSync(process.argv[1], renderServerPatchScript('container-verify'))" "${TMP_SCRIPT}"

echo "Using ${RUNTIME} with ${IMAGE}"
"${RUNTIME}" pull "${IMAGE}" >/dev/null

"${RUNTIME}" run --rm \
  -v "${TMP_SCRIPT}:/server-patch.sh:ro" \
  "${IMAGE}" \
  bash -lc 'set -euo pipefail
mkdir -p /tmp/stubs /etc/apt/apt.conf.d /etc/modprobe.d
printf "deb https://ppa.launchpadcontent.net/nilarimogard/webupd8/ubuntu noble main\n" > /etc/apt/sources.list.d/deploy-setup-bad-ppa.list
cat > /tmp/stubs/apt-get <<'"'"'APTSTUB'"'"'
#!/bin/sh
if [ "$1" = "update" ] && [ ! -f /tmp/deploy-setup-apt-update-seen ]; then
  touch /tmp/deploy-setup-apt-update-seen
  echo "错误:1 https://ppa.launchpadcontent.net/nilarimogard/webupd8/ubuntu noble Release"
  echo "E: 仓库 “https://ppa.launchpadcontent.net/nilarimogard/webupd8/ubuntu noble Release” 没有 Release 文件。"
  exit 100
fi
echo stub-apt-get "$@"
exit 0
APTSTUB
chmod +x /tmp/stubs/apt-get
for cmd in systemctl update-initramfs rmmod nginx sudo; do
  printf "#!/bin/sh\necho stub-%s \"\$@\"\nexit 0\n" "$cmd" > "/tmp/stubs/$cmd"
  chmod +x "/tmp/stubs/$cmd"
done
PATH=/tmp/stubs:/usr/sbin:/usr/bin:/sbin:/bin bash /server-patch.sh
test -f /etc/apt/apt.conf.d/20auto-upgrades
grep -q "Unattended-Upgrade" /etc/apt/apt.conf.d/20auto-upgrades
grep -q "disabled by deploy-setup" /etc/apt/sources.list.d/deploy-setup-bad-ppa.list
grep -q "install algif_aead /bin/false" /etc/modprobe.d/deploy-setup-local-lpe.conf
grep -q "install rxrpc /bin/false" /etc/modprobe.d/deploy-setup-local-lpe.conf
echo CONTAINER_PATCH_TEST_OK'

echo "Container verification passed."
