// The compose file `tallyline setup` writes to ~/.tallyline/compose.yml. It runs
// the published images (no source checkout, no build) with the same environment
// contract as docker-compose.selfhost.yml. Every value comes from the sibling
// `.env`, which setup generates with 0600 permissions.

export const IMAGE_REPO = "ghcr.io/duketopceo";

export const COMPOSE_TEMPLATE = `# Written by \`tallyline setup\`. Safe to leave alone; \`tallyline update\` edits .env, not this file.
name: tallyline

services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?}
      POSTGRES_DB: tallyline
    volumes:
      - tallyline-postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d tallyline"]
      interval: 5s
      timeout: 5s
      retries: 12
    restart: unless-stopped

  api:
    image: ${IMAGE_REPO}/tallyline-api:\${TALLYLINE_IMAGE_TAG:?}
    environment:
      NODE_ENV: production
      API_PORT: "4000"
      DATABASE_URL: postgresql://postgres:\${POSTGRES_PASSWORD}@postgres:5432/tallyline
      JWT_SECRET: \${JWT_SECRET:?}
      AUTH_SECRET_KEY: \${AUTH_SECRET_KEY:?}
      API_BASE_URL: \${API_BASE_URL:?}
      WEB_URL: \${WEB_URL:?}
      TALLYLINE_VERSION: \${TALLYLINE_IMAGE_TAG}
      TALLYLINE_BACKUP_MARKER: /backups/.last-backup
    volumes:
      - ./backups:/backups:ro
    ports:
      - "\${API_PUBLISH_PORT:-4000}:4000"
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  web:
    image: ${IMAGE_REPO}/tallyline-web:\${TALLYLINE_IMAGE_TAG:?}
    environment:
      NODE_ENV: production
      API_INTERNAL_URL: http://api:4000
    ports:
      - "\${WEB_PUBLISH_PORT:-3100}:3100"
    depends_on:
      - api
    restart: unless-stopped

volumes:
  tallyline-postgres:
    name: tallyline-postgres
`;
