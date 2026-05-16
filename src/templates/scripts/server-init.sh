#!/bin/bash
set -euo pipefail

APP_NAME="{{APP_NAME}}"
DEPLOY_DIR="{{DEPLOY_DIR}}"
APP_DIR="${DEPLOY_DIR}/${APP_NAME}"
APP_PORT="{{APP_PORT}}"
DOMAIN_ENABLED="{{DOMAIN_ENABLED}}"
DOMAIN_NAME="{{DOMAIN_NAME}}"
HTTPS_ENABLED="{{HTTPS_ENABLED}}"

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

run_apt_security_updates() {
    if ! command -v apt-get &> /dev/null; then
        echo "  非 apt 系统，跳过自动安全升级"
        return
    fi

    export DEBIAN_FRONTEND=noninteractive
    export NEEDRESTART_MODE=a
    APT_OPTS="-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"

    apt-get update
    apt-get install ${APT_OPTS} unattended-upgrades kmod
    apt-get upgrade ${APT_OPTS}

    cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APTCONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APTCONF

    if command -v nginx &> /dev/null; then
        nginx -v 2>&1 | sed 's/^/  /'
        systemctl try-restart nginx 2>/dev/null || true
    fi
}

apply_kernel_lpe_mitigations() {
    if [ ! -d /etc/modprobe.d ] || [ ! -r /proc/modules ]; then
        echo "  当前系统不支持 modprobe 缓解检查，跳过"
        return
    fi

    cat > /etc/modprobe.d/deploy-setup-local-lpe.conf <<'MODPROBE'
# deploy-setup automatic mitigation for recent Linux kernel local privilege escalation classes.
# Copy Fail / CVE-2026-31431: block algif_aead.
# Dirty Frag / Fragnesia: block esp4, esp6, and rxrpc.
install algif_aead /bin/false
install esp4 /bin/false
install esp6 /bin/false
install rxrpc /bin/false
MODPROBE

    update-initramfs -u -k all 2>/dev/null || true
    rmmod algif_aead esp4 esp6 rxrpc 2>/dev/null || true

    if grep -qE '^(algif_aead|esp4|esp6|rxrpc) ' /proc/modules; then
        warn "部分 LPE 缓解模块仍在使用中，需重启服务器后完全生效"
        grep -E '^(algif_aead|esp4|esp6|rxrpc) ' /proc/modules || true
    else
        ok "Linux 本地提权缓解已生效"
    fi
}

# ─── 开始 ───
echo -e "${CYAN}=== 服务器初始化: ${APP_NAME} ===${NC}"
echo "  目录: ${APP_DIR} | 端口: ${APP_PORT}"
[ "${DOMAIN_ENABLED}" = "true" ] && echo "  域名: ${DOMAIN_NAME} | HTTPS: ${HTTPS_ENABLED}"

# ─── Step 0: Security ───
step "0/7 应用安全补丁与本地提权缓解"
run_apt_security_updates
apply_kernel_lpe_mitigations
ok "安全基线检查完成"

# ─── Step 1: Docker ───
step "1/7 检查 Docker"
if command -v docker &> /dev/null; then
    ok "Docker 已安装: $(docker --version)"
else
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker && systemctl start docker
    ok "Docker 安装完成: $(docker --version)"
fi

# ─── Step 1.5: Docker 镜像源 ───
MIRROR_DOCKER='{{MIRROR_DOCKER}}'
if [ -n "${MIRROR_DOCKER}" ]; then
    step "1.5/7 配置 Docker 镜像源"
    mkdir -p /etc/docker
    cat > /etc/docker/daemon.json << DAEMON_EOF
{
  "registry-mirrors": [${MIRROR_DOCKER}]
}
DAEMON_EOF
    systemctl restart docker
    ok "Docker 镜像源已配置"
fi

# ─── Step 2: Docker Compose ───
step "2/7 检查 Docker Compose"
if docker compose version &> /dev/null; then
    ok "Docker Compose 已安装: $(docker compose version --short)"
else
    apt-get update && apt-get install -y docker-compose-plugin
    ok "Docker Compose 安装完成: $(docker compose version --short)"
fi

# ─── Step 3: 部署目录 ───
step "3/7 创建部署目录"
mkdir -p "${APP_DIR}"
ok "目录就绪: ${APP_DIR}"
ls -la "${APP_DIR}"

# ─── Step 3.5: 端口冲突检测 ───
step "3.5/7 检查端口 ${APP_PORT}"
CONFLICT_PID=$(ss -tlnp | grep ":${APP_PORT} " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "$CONFLICT_PID" ]; then
    CONFLICT_CMD=$(ps -p "$CONFLICT_PID" -o comm= 2>/dev/null || echo "unknown")
    echo -e "${RED}  ⚠ 端口 ${APP_PORT} 已被占用: PID=$CONFLICT_PID ($CONFLICT_CMD)${NC}"
    echo "  请手动处理后重新运行:"
    echo "    kill $CONFLICT_PID  # 或 pm2 delete <name>"
    exit 1
else
    ok "端口 ${APP_PORT} 可用"
fi

# ─── Step 4: 初始化 .env ───
step "4/7 初始化 .env"
if [ ! -f "${APP_DIR}/.env" ]; then
    cat > "${APP_DIR}/.env" << 'ENVFILE'
{{ENV_HARDCODED_LINES}}
{{ENV_SECRET_PLACEHOLDER_LINES}}
ENVFILE
    sed -i 's/^ *//' "${APP_DIR}/.env"
    ok "已生成 .env（非敏感值已填入，敏感值由 CI/CD 注入）"
    echo "  ${APP_DIR}/.env"
    cat "${APP_DIR}/.env"
else
    ok ".env 已存在，跳过"
fi

# ─── Step 5: 复制 compose 文件 ───
step "5/7 部署 docker-compose.yml"
if [ -f "docker-compose.yml" ]; then
    cp docker-compose.yml "${APP_DIR}/"
    ok "已复制到 ${APP_DIR}/docker-compose.yml"
else
    echo "  当前目录无 docker-compose.yml，跳过（后续由 CI/CD 部署）"
fi

# ─── Step 6: Nginx 反向代理 ───
PROXY_MODE="{{PROXY_MODE}}"
if [ "${DOMAIN_ENABLED}" = "true" ] && [ "${PROXY_MODE}" != "existing-caddy" ] && [ "${PROXY_MODE}" != "none" ]; then
    step "6/7 配置 Nginx 反向代理"

    if ! command -v nginx &> /dev/null; then
        apt-get update && apt-get install -y nginx
        systemctl enable nginx
    fi
    ok "Nginx 已安装: $(nginx -v 2>&1)"

    cat > /etc/nginx/sites-available/${APP_NAME} <<NGINX
server {
    listen 80;
    server_name ${DOMAIN_NAME};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

    ln -sf /etc/nginx/sites-available/${APP_NAME} /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default
    nginx -t
    systemctl reload nginx
    ok "反向代理已生效: ${DOMAIN_NAME} → 127.0.0.1:${APP_PORT}"
    echo "  验证: curl -H 'Host: ${DOMAIN_NAME}' http://127.0.0.1"
elif [ "${DOMAIN_ENABLED}" = "true" ] && [ "${PROXY_MODE}" = "existing-caddy" ]; then
    step "6/7 Nginx"
    echo "  使用现有 Caddy，跳过 Nginx 配置"
elif [ "${DOMAIN_ENABLED}" = "true" ] && [ "${PROXY_MODE}" = "none" ]; then
    step "6/7 Nginx"
    echo "  无反向代理，跳过"
else
    step "6/7 Nginx"
    echo "  未配置域名，跳过"
fi

# ─── Step 6: HTTPS ───
if [ "${DOMAIN_ENABLED}" = "true" ] && [ "${HTTPS_ENABLED}" = "true" ]; then
    step "7/7 配置 HTTPS (Let's Encrypt)"

    if ! command -v certbot &> /dev/null; then
        apt-get install -y certbot python3-certbot-nginx
    fi
    ok "certbot 已安装"

    certbot --nginx -d ${DOMAIN_NAME} --non-interactive --agree-tos --email admin@${DOMAIN_NAME} --redirect
    ok "SSL 证书已签发"
    certbot certificates 2>/dev/null | grep -A2 "Certificate Name"
else
    step "7/7 HTTPS"
    echo "  未启用，跳过"
fi

# ─── Pre-deploy cleanup ───
step "清理旧资源"
docker image prune -f 2>/dev/null || true
ok "清理完成"

# ─── 完成 ───
echo ""
echo -e "${GREEN}=== 全部完成 ===${NC}"
echo "  部署目录: ${APP_DIR}"
if [ "${DOMAIN_ENABLED}" = "true" ]; then
    [ "${HTTPS_ENABLED}" = "true" ] && echo "  访问: https://${DOMAIN_NAME}" || echo "  访问: http://${DOMAIN_NAME}"
else
    echo "  访问: http://$(hostname -I | awk '{print $1}'):${APP_PORT}"
fi
