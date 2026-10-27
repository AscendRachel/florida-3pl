# Running Florida 3PL in Docker

## Where the image comes from
Every push to `main` on GitHub builds the image and publishes it to Docker Hub as `ascendrachel/florida-3pl:latest`
(see `.github/workflows/docker.yml`; it needs the secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` in the GitHub repo).

## Start it
```
docker compose up -d
```
Open http://localhost:8765 (or http://SERVER-IP:8765 from another PC).

## Create the first admin (once)
The sign-in page only lets you create the first account from the server PC itself, which a container cannot do, so make it from the command line:
```
docker compose exec app python server.py create-admin
```
It asks for a username, a display name and a password (8+ characters). Then sign in.

## Your data
Everything is stored in the `data` folder next to `docker-compose.yml` (a bind mount), so it survives rebuilds and restarts.
To move your existing app over, copy your current `data` folder (orders.db, returns.db, auth.db, ...) into that place **before the first start**, or stop the container first.
Back the folder up regularly.

## Update to a new version
```
docker compose pull
docker compose up -d
```
To build from the source instead (for example on a PC without internet access to Docker Hub), replace the `image:` line in
`docker-compose.yml` with `build: .` and run `docker compose up -d --build`.

## Useful commands
```
docker compose logs -f        # watch the log
docker compose restart        # restart
docker compose down           # stop (the data stays)
```

## Using it from the internet (US team)
Do not expose port 8765 directly. Put an HTTPS reverse proxy in front (Caddy, Nginx, Cloudflare Tunnel) that passes
`X-Forwarded-Proto: https`, so sign-in cookies are marked Secure.
