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

disable_apt_source_file_url() {
    local source_file="$1"
    local source_url="$2"
    local stamp="$3"
    local tmp_file

    if [ "${source_file##*.}" = "sources" ]; then
        as_root mv "$source_file" "${source_file}.disabled-by-deploy-setup-${stamp}"
        warn "已禁用失效 apt 源文件: ${source_file}"
        return
    fi

    tmp_file="$(mktemp)"
    awk -v url="$source_url" '
        index($0, url) && $0 !~ /^[[:space:]]*#/ {
            print "# disabled by deploy-setup due to apt update failure: " $0
            next
        }
        { print }
    ' "$source_file" > "$tmp_file"

    as_root cp "$source_file" "${source_file}.deploy-setup-backup-${stamp}" 2>/dev/null || true
    write_root_file "$source_file" < "$tmp_file"
    rm -f "$tmp_file"
    warn "已注释失效 apt 源: ${source_file} (${source_url})"
}

disable_broken_apt_sources() {
    local log_file="$1"
    local urls_file
    local source_url
    local source_file
    local disabled=0
    local stamp

    urls_file="$(mktemp)"
    stamp="$(date +%Y%m%d%H%M%S)"

    awk '
        /Release/ && /(file|文件)/ {
            line=$0
            while (match(line, /https?:\/\/[^ "”“'\''’‘]+/)) {
                print substr(line, RSTART, RLENGTH)
                line=substr(line, RSTART + RLENGTH)
            }
        }
    ' "$log_file" | sort -u > "$urls_file"

    while IFS= read -r source_url; do
        [ -n "$source_url" ] || continue
        warn "发现失效 apt 源: ${source_url}"

        for source_file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
            [ -e "$source_file" ] || continue
            if grep -qF "$source_url" "$source_file" 2>/dev/null; then
                disable_apt_source_file_url "$source_file" "$source_url" "$stamp"
                disabled=$((disabled + 1))
            fi
        done
    done < "$urls_file"

    rm -f "$urls_file"

    if [ "$disabled" -eq 0 ]; then
        warn "未能自动定位失效 apt 源文件"
        return 1
    fi

    ok "已禁用 ${disabled} 个失效 apt 源，准备重试 apt-get update"
}

apt_update_with_repair() {
    local log_file
    log_file="$(mktemp)"

    if as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update 2>&1 | tee "$log_file"; then
        rm -f "$log_file"
        return
    fi

    warn "apt-get update 失败，尝试禁用失效第三方源后重试"
    disable_broken_apt_sources "$log_file"
    rm -f "$log_file"

    as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update
}

is_retryable_apt_fetch_error() {
    local log_file="$1"
    grep -Eq '404|Not Found|无法下载|Hash Sum mismatch|File has unexpected size|--fix-missing' "$log_file"
}

refresh_apt_indexes_for_retry() {
    warn "刷新 apt 缓存并重试"
    as_root apt-get clean 2>/dev/null || true
    as_root rm -rf /var/lib/apt/lists/partial 2>/dev/null || true
    as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
        apt-get update \
        -o Acquire::http::No-Cache=true \
        -o Acquire::https::No-Cache=true
}

apt_command_with_mirror_retry() {
    local label="$1"
    shift
    local log_file
    log_file="$(mktemp)"

    if as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get "$@" 2>&1 | tee "$log_file"; then
        rm -f "$log_file"
        return
    fi

    if ! is_retryable_apt_fetch_error "$log_file"; then
        rm -f "$log_file"
        return 1
    fi

    warn "${label} 遇到镜像下载错误，准备刷新索引后重试"
    refresh_apt_indexes_for_retry

    if as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get --fix-missing "$@" 2>&1 | tee "$log_file"; then
        rm -f "$log_file"
        return
    fi

    if is_retryable_apt_fetch_error "$log_file"; then
        warn "${label} 仍因镜像不同步失败，已跳过该 apt 步骤；请稍后重跑 patch-server 或更换镜像源"
        rm -f "$log_file"
        return
    fi

    rm -f "$log_file"
    return 1
}

run_apt_security_updates() {
    if ! command -v apt-get &> /dev/null; then
        echo "  非 apt 系统，跳过自动安全升级"
        return
    fi

    APT_OPTS="-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"

    apt_update_with_repair
    apt_command_with_mirror_retry "安装安全更新依赖" install ${APT_OPTS} unattended-upgrades kmod
    apt_command_with_mirror_retry "系统安全升级" upgrade ${APT_OPTS}

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

report_security_review_hint() {
    warn "请检查是否有异常提权的情况：重点查看 sudo/登录日志、异常用户、异常 SUID 文件、可疑进程和计划任务"
}

echo -e "${CYAN}=== deploy-setup 服务器补丁: ${PATCH_TARGET} ===${NC}"

step "1/3 应用系统安全更新"
run_apt_security_updates
ok "系统安全更新完成"

step "2/3 应用 Linux 本地提权缓解"
apply_kernel_lpe_mitigations

step "3/3 检查重启状态"
report_reboot_status
report_security_review_hint

echo ""
echo -e "${GREEN}=== 服务器补丁完成 ===${NC}"
