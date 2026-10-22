# Node.js + Grafana + Loki LAN demo

A dependency-free Node.js API with three GET endpoints, real thrown errors, structured JSON logs, and a ready-to-use Grafana dashboard.

## Simple log reader

Open **http://localhost:3000** (or `http://YOUR-LAN-IP:3000`) for the built-in log reader. No Grafana login or query language is needed.

- Logs refresh every two seconds; use **Live** to pause or resume.
- Search messages, request IDs, HTTP statuses, or paths.
- Filter errors, endpoint, and time range (15 minutes, one hour, or 24 hours).
- Click a message to see request attributes, JSON, and its error stack.
- Click **Generate test logs** to send a 200, 500, and 503 request.

The reader shows the latest 500 logs in the selected period; search and filters apply to those loaded records. In Compose it reads persistent logs from Loki. When running Node alone, it shows the latest 500 logs from the current server session. Viewing and polling the reader do not generate application request logs. The reader is available without authentication to devices that can reach the API on your trusted LAN, and shows the same application logs and error details you would see in Grafana.

## Push an error event

Open **http://localhost:3000/push-event** or click **Push event** in the reader. The page previews errors from the last five minutes. Enter an HTTP/HTTPS destination URL, optionally add headers as a JSON object, and click **Send event** to make a server-side POST.

```json
{
  "Authorization": "Bearer your-token",
  "X-API-Key": "your-key"
}
```

The JSON event contains the time window, error counts by HTTP status and endpoint, average error response time, and error log records with timestamps, messages, request IDs, and stacks. It sends the exact preview shown; use **Refresh** to include newer errors. Collection may lag a few seconds behind requests. The preview expires in ten minutes and can only be sent once after the destination responds. Destination status and up to 4 KiB of response text are shown. Redirects are not followed and failed deliveries are not retried automatically.

Headers are held in the form and used only for the send; destination URLs and headers are excluded from application request logs. Up to 1,000 errors are included, with an explicit truncation flag if the window exceeds this limit. With Node alone, coverage is limited to the current session's 500-log buffer; Compose reads stored errors from Loki. An empty window can be sent as a zero-error event. LAN receivers must be reachable from the API container: `localhost` refers to that container; for a receiver on the Docker Desktop host use `http://host.docker.internal:PORT/path`, or use its reachable LAN IP.

## Run everything

Install Docker with the Compose plugin, then from this directory:

If this workspace already has a generated `.env`, keep it and run `docker compose up -d --build` directly. The generated Grafana password is in that file. For a fresh copy:

```sh
cp .env.example .env
# Edit .env to set GRAFANA_ADMIN_PASSWORD.
docker compose up -d --build
```

- Log reader: http://localhost:3000
- API: http://localhost:3000/users
- Grafana: http://localhost:3001 — log in with `admin` and the password from `.env`.
- Open **Dashboards → Node API → Node API overview**.

The API image is built locally as `lan-loki-api:local`. Grafana, Loki, and Alloy run as separate containers in the same Compose stack. First startup needs internet access to download images; no cloud account is required.

## Endpoints and error simulation

| GET endpoint | Random JSON data |
| --- | --- |
| `/users` | ID, name, online state |
| `/products` | ID, product, price, stock |
| `/orders` | ID, order status, total, item count |

All three support the same query parameters:

```sh
curl -i http://localhost:3000/users
curl -i 'http://localhost:3000/products?error=true'
curl -i 'http://localhost:3000/orders?error=true&status=503'
```

`?error=true` throws an error and returns HTTP **500**. Add `&status=503` to return HTTP **503** instead. `&status=500` is also accepted. Other error status values return HTTP 400. `error=false` (or no error parameter) returns HTTP 200. The server continues serving requests after a simulated error.

Every response is JSON and includes a request ID, also available in the `X-Request-Id` header. Error responses look like:

```json
{
  "success": false,
  "requestId": "a-generated-uuid",
  "error": { "status": 503, "message": "Simulated service unavailable" }
}
```

Each completed request logs its method, path, status, duration, and request ID. Failed requests also log the error stack, which is omitted from the response.

## Access from your LAN

On another device connected to the same LAN, replace `localhost` with the Docker host's LAN IP, for example:

```sh
curl 'http://192.168.1.50:3000/users?error=true&status=503'
```

Open `http://192.168.1.50:3001` for Grafana. Docker publishes both ports on all host interfaces. Allow inbound TCP 3000 and 3001 in the host firewall if necessary. Set `API_PORT` and `GRAFANA_PORT` in `.env` if those ports are occupied. This demo is intended for a trusted LAN: the API is public to devices that can reach it, Grafana requires login, and Loki/Alloy have no published host ports. Avoid forwarding these ports from your router to the internet.

## View logs

The flow is **API → shared log volume → Grafana Alloy → Loki → Grafana**. Alloy reads the application file without access to the Docker socket. The API also writes identical JSON logs to stdout.

The provisioned dashboard shows request counts, HTTP 5xx errors, request rate by status, average response time by endpoint, and live logs. Send a few requests and allow about 10–30 seconds for collection and dashboard refresh. HTTP 500/503 results are expected test failures, not container crashes.

In Grafana **Explore**, choose **Loki** and try:

```logql
{service_name="node-api"}
```

```logql
{service_name="node-api", level="error"} | json
```

```logql
{service_name="node-api"} | json | status = 503
```

To find a specific request, use `{service_name="node-api"} | json | requestId="YOUR_ID"`.

Loki retains logs for seven days, with asynchronous deletion. Grafana settings, Loki data, and Alloy read positions persist in named volumes. The application keeps a 10 MiB log file and one backup; Docker stdout logs rotate separately. This is a small single-host demo, with no high-availability storage. Heavy traffic or an extended collector outage can overrun the local log buffer.

Configuration references: [Alloy file collection](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.file/), [Loki filesystem storage](https://grafana.com/docs/loki/latest/operations/storage/filesystem/), [Grafana Docker setup](https://grafana.com/docs/grafana/latest/setup-grafana/installation/docker/).

## Local development and tests

Node.js 22 or later is required. There are no npm dependencies to install.

```sh
npm start
npm test
```

For watch mode, use `npm run dev`. Optionally set `PORT` and `LOG_FILE` for local runs; by default local logs go only to stdout. The Docker image uses Node.js 24 and writes to the shared volume automatically.

## Build or move the API image separately

```sh
docker build -t lan-loki-api:local .
docker run --rm -p 3000:3000 lan-loki-api:local
```

The standalone image serves the API and stdout logs; use Compose for the complete logging stack. You can transfer the API image to a machine with the same CPU architecture:

```sh
docker save -o lan-loki-api.tar lan-loki-api:local
# Copy the tar and this project to your LAN server, then on that server:
docker load -i lan-loki-api.tar
docker compose up -d --no-build
```

For a different CPU architecture, copy the project and build on the target with `docker compose up -d --build`.

## Manage the stack

```sh
docker compose ps
docker compose logs -f api alloy loki
docker compose down
```

`docker compose down` preserves stored data. `docker compose down -v` deletes all stack volumes, including logs and Grafana settings. Grafana uses the admin password from `.env` only when initializing a new database; change an existing password through Grafana's UI.
