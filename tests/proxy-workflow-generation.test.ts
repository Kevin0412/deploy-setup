import { describe, it, expect } from 'vitest'
import { replacePlaceholders, readTemplate } from '../src/utils/template'

describe('Proxy workflow template rendering', () => {
  const baseVars: Record<string, string> = {
    BRANCH_PRODUCTION: 'main',
    CHECKOUT_TOKEN_SECRET: 'GH_RELEASE_REPO_TOKEN',
    PROXY_REPO_OWNER: 'Infinity-light',
    PROXY_REPO_NAME: 'vibecraft-releases',
    APP_NAME: 'vibecraft',
    APP_PORT: '3001',
    DEPLOY_DIR: '/opt/apps/vibecraft',
    DEPLOY_TIMEOUT_MINUTES: '20',
    HEALTH_PATH: '',
    COMPOSE_FILE: 'docker-compose.prod.yml',
    SERVER_BUILD_CMD: 'pnpm --filter server build',
    ADMIN_BUILD_CMD: 'pnpm --filter admin build',
    ENV_PROXY_SECRET_ENV_BLOCK: '          DB_PASSWORD: ${{ secrets.DB_PASSWORD }}',
    ENV_PROXY_WRITE_BLOCK: '          echo "NODE_ENV=production" >> .env',
    DB_MIGRATE_CMD: '',
    NGINX_SYNC_CMD: '',
  }

  it('renders proxy-trigger-deploy.yml with correct dispatch config', () => {
    const template = readTemplate('workflows', 'proxy-trigger-deploy.yml')
    const rendered = replacePlaceholders(template, baseVars)

    expect(rendered).toContain('repository-dispatch@v3')
    expect(rendered).toContain('token: ${{ secrets.GH_RELEASE_REPO_TOKEN }}')
    expect(rendered).toContain('repository: Infinity-light/vibecraft-releases')
    expect(rendered).toContain('event-type: deploy')
    expect(rendered).toContain('branches:')
    expect(rendered).toContain('- main')
  })

  it('renders proxy-trigger-release.yml with tag trigger', () => {
    const template = readTemplate('workflows', 'proxy-trigger-release.yml')
    const rendered = replacePlaceholders(template, baseVars)

    expect(rendered).toContain("- 'v*'")
    expect(rendered).toContain('event-type: release')
    expect(rendered).toContain('repository: Infinity-light/vibecraft-releases')
  })

  it('renders proxy-monorepo-node.yml with deploy steps', () => {
    const template = readTemplate('workflows', 'proxy-monorepo-node.yml')
    const rendered = replacePlaceholders(template, baseVars)

    expect(rendered).toContain('repository_dispatch')
    expect(rendered).toContain('types: [deploy]')
    expect(rendered).toContain('token: ${{ secrets.GH_RELEASE_REPO_TOKEN }}')
    expect(rendered).toContain('/opt/apps/vibecraft')
    expect(rendered).toContain('docker compose')
    expect(rendered).toContain('Health check')
    expect(rendered).toContain('[ "$STATUS" -lt 400 ]')
    expect(rendered).not.toContain('[ "$STATUS" -lt 500 ]')
  })

  it('renders proxy-tauri-desktop.yml with release steps', () => {
    const template = readTemplate('workflows', 'proxy-tauri-desktop.yml')
    const rendered = replacePlaceholders(template, baseVars)

    expect(rendered).toContain('repository_dispatch')
    expect(rendered).toContain('types: [release]')
    expect(rendered).toContain('tauri build')
    expect(rendered).toContain('upload-artifact@v4')
    expect(rendered).toContain('action-gh-release@v2')
  })

  it('conditional blocks are removed when vars are empty', () => {
    const template = readTemplate('workflows', 'proxy-monorepo-node.yml')
    const vars = { ...baseVars, DB_MIGRATE_CMD: '', NGINX_SYNC_CMD: '' }
    const rendered = replacePlaceholders(template, vars)

    expect(rendered).not.toContain('Database migration')
    expect(rendered).not.toContain('Sync nginx')
  })

  it('conditional blocks are included when vars have values', () => {
    const template = readTemplate('workflows', 'proxy-monorepo-node.yml')
    const vars = {
      ...baseVars,
      DB_MIGRATE_CMD: 'docker exec -i postgres psql -U app < migrations.sql',
      NGINX_SYNC_CMD: 'sudo cp nginx.conf /etc/nginx/sites-available/ && sudo nginx -s reload',
    }
    const rendered = replacePlaceholders(template, vars)

    expect(rendered).toContain('Database migration')
    expect(rendered).toContain('Sync nginx')
  })
})
