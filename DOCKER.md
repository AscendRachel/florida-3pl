# Running Florida 3PL in Docker

## Where the image comes from
Every push to `main` on GitHub builds the image and publishes it to Docker Hub as `ascendrachel/florida-3pl:latest`
(see `.github/workflows/docker.yml`; it needs the secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` in the GitHub repo).

## Port
Inside the container the app listens on **8080** (set by `PORT` in the Dockerfile). To publish it on another port of the server,
change the left number in `docker-compose.yml`, for example `"9000:8080"`.

## Start it
```
docker compose up -d
```
Open http://localhost:8080 (or http://SERVER-IP:8080 from another PC).

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

## Using it from the internet with a domain (no port number) - Caddy
Caddy gives the app HTTPS and a normal address like https://orders.yourcompany.com. Do not open port 8080 to the internet.

1. In your DNS, add an **A record** for the name you want (for example `orders`) that points to the server's IP.
2. On the server, copy `.env.example` to `.env` and set `DOMAIN=orders.yourcompany.com`.
3. Start the app and Caddy together:
```
docker compose -f docker-compose.caddy.yml up -d
```
4. Open https://orders.yourcompany.com. Ports 80 and 443 must be open on the server (Caddy needs 80 to get the certificate).
5. Create the first admin as above, using the same file:
```
docker compose -f docker-compose.caddy.yml exec app python server.py create-admin
```

If the server **already runs its own Caddy**, do not start a second one. Add this to the existing Caddyfile and make sure both
containers share a Docker network (use the app container name `florida-3pl`):
```
orders.yourcompany.com {
	reverse_proxy florida-3pl:8080
}
```
Caddy sends `X-Forwarded-Proto: https` by itself, which is what the app needs to mark sign-in cookies as Secure.
