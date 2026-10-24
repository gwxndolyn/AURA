# AURA — one image, two roles (web server and job worker).
#   docker build -t aura:latest .
#   behind TLS interception: docker build --secret id=ca,src=/path/corp-ca.pem -t aura:latest .
# Run:
#   web:    docker run -p 3000:3000 --env-file .env -e AURA_WORKER=external aura:latest
#   worker: docker run --env-file .env -v /var/run/docker.sock:/var/run/docker.sock aura:latest worker
# (`worker` runs node directly as PID 1's child via tini-like exec so SIGTERM reaches it: graceful drain.)
# The worker needs the Docker socket only for the code-execution sandbox (docker CLI talks to the host
# daemon); without it, engineering runs fail honestly with sandbox_unavailable.
# Self-modification tests use Dockerfile.selfmod.

FROM node:20-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ca,required=false sh -c 'if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; npm ci --ignore-scripts --no-audit --no-fund'
COPY prisma ./prisma
RUN --mount=type=secret,id=ca,required=false sh -c 'if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; npx prisma generate'
COPY . .
RUN DATABASE_URL=file:/tmp/build.db npx next build

FROM node:20-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production
# docker CLI for the code sandbox (static binary copied from the official image; no apt mirror needed)
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
COPY --chown=node:node scripts/docker-entrypoint.sh /usr/local/bin/aura-entrypoint
ENTRYPOINT ["/usr/local/bin/aura-entrypoint"]
CMD ["web"]
