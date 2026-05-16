#!/bin/bash
set -euo pipefail

PATCH_TARGET="{{PATCH_TARGET}}"

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

CURRENT_STEP=""

on_error() {
    echo ""
    echo -e "${RED}✗ 失败于: [${CURRENT_STEP}]${NC}"
    echo -e "${RED}  退出码: $?${NC}"
    echo -e "${RED}  请检查上方输出定位问题${NC}"
    exit 1
}
trap on_error ERR

step() {
    CURRENT_STEP="$1"
    echo ""
    echo -e "${CYAN}[${CURRENT_STEP}]${NC}"
}

ok() {
    echo -e "${GREEN}  ✔ $1${NC}"
}

warn() {
    echo -e "${RED}  ⚠ $1${NC}"
}

as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

write_root_file() {
    local target="$1"
    if [ "$(id -u)" -eq 0 ]; then
        cat > "$target"
    else
        sudo tee "$target" >/dev/null
    fi
}

run_apt_security_updates() {
    if ! command -v apt-get &> /dev/null; then
        echo "  非 apt 系统，跳过自动安全升级"
        return
    fi

    APT_OPTS="-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"

    as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install ${APT_OPTS} unattended-upgrades kmod
    as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get upgrade ${APT_OPTS}

    as_root mkdir -p /etc/apt/apt.conf.d
    write_root_file /etc/apt/apt.conf.d/20auto-upgrades <<'APTCONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APTCONF

    if command -v nginx &> /dev/null; then
        nginx -v 2>&1 | sed 's/^/  /'
        as_root systemctl try-restart nginx 2>/dev/null || true
    fi
}

apply_kernel_lpe_mitigations() {
    if [ ! -r /proc/modules ]; then
        echo "  当前系统不支持 modprobe 缓解检查，跳过"
        return
    fi

    as_root mkdir -p /etc/modprobe.d
    write_root_file /etc/modprobe.d/deploy-setup-local-lpe.conf <<'MODPROBE'
# deploy-setup automatic mitigation for recent Linux kernel local privilege escalation classes.
# Copy Fail / CVE-2026-31431: block algif_aead.
# Dirty Frag / Fragnesia: block esp4, esp6, and rxrpc.
install algif_aead /bin/false
install esp4 /bin/false
install esp6 /bin/false
install rxrpc /bin/false
MODPROBE

    as_root update-initramfs -u -k all 2>/dev/null || true
    as_root rmmod algif_aead esp4 esp6 rxrpc 2>/dev/null || true

    if grep -qE '^(algif_aead|esp4|esp6|rxrpc) ' /proc/modules; then
        warn "部分 LPE 缓解模块仍在使用中，需重启服务器后完全生效"
        grep -E '^(algif_aead|esp4|esp6|rxrpc) ' /proc/modules || true
    else
        ok "Linux 本地提权缓解已生效"
    fi
}

report_reboot_status() {
    if [ -f /var/run/reboot-required ]; then
        warn "系统提示需要重启以启用新内核或关键库"
        if [ -f /var/run/reboot-required.pkgs ]; then
            sed 's/^/  /' /var/run/reboot-required.pkgs
        fi
    else
        ok "当前未检测到 reboot-required 标记"
    fi
}

echo -e "${CYAN}=== deploy-setup 服务器补丁: ${PATCH_TARGET} ===${NC}"

step "1/3 应用系统安全更新"
run_apt_security_updates
ok "系统安全更新完成"

step "2/3 应用 Linux 本地提权缓解"
apply_kernel_lpe_mitigations

step "3/3 检查重启状态"
report_reboot_status

echo ""
echo -e "${GREEN}=== 服务器补丁完成 ===${NC}"
