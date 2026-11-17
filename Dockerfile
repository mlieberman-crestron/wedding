# Wedding Platform image (build-from-source variant, Path B).
#
# Base image: node:26-alpine
#  - Node 26 is the current Active LTS line (LTS since 28 Oct 2026, supported
#    to April 2029).
#  - node:sqlite works without the --experimental-sqlite flag from Node 22.13 /
#    23.4 onward, so any Node 26 qualifies.
#  - Alpine keeps the image small; the official tag is published for amd64 and
#    arm64, so it runs on either NAS CPU type. Nothing is compiled.
# For fully repeatable builds you could pin the exact version (e.g.
# node:26.13.1-alpine); the major-version tag picks up security patches.
FROM node:26-alpine

WORKDIR /app

# The app has zero npm dependencies, so there is no package.json / npm install.
# app/ holds app.js plus its modules and public/ (stylesheet, import script).
COPY app/ /app/

# Defaults; docker-compose.yml overrides these from .env.
ENV PORT=3000 \
    DATA_DIR=/data \
    APP_ENV=dev \
    NODE_ENV=production

EXPOSE 3000

# --- Non-root user and /data permissions -----------------------------------
# There is deliberately no `USER node` line here. /data is a bind mount of a
# NAS folder whose owner we cannot predict (on TOS it is often root), and a
# process that starts as `node` cannot fix that without SSH access.
# Instead the container starts as root and app.js immediately:
#   1. creates /data if needed and chowns it and everything in it (app.db,
#      backups/) to node (uid/gid 1000),
#   2. switches the process to the node user permanently (setgroups/setgid/
#      setuid),
# before it opens the database or listens on the port. See dropPrivileges()
# in app/perms.js. Result: the server itself runs as `node`.
# If you prefer to start as non-root, set `user: "1000:1000"` in compose and
# make the data folder writable by uid 1000 yourself.

# Health check using Node itself (no curl in Alpine). fetch() is built in.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "/app/app.js"]
