# Backsoon — back-in-stock alerts

A small, self-contained notification service for a simulated store. Customers can request an alert for a SKU; confirmed restocks are processed by a persistent worker and sent through a Resend-compatible email API.

## Run with Docker

Requires Docker, the challenge sandbox credentials, and a writable persistent volume. The container starts one app process and listens on `PORT` (default 3000). No database service or npm installation is needed.

1. Sign up at the challenge test server and copy the generated values to a local `.env` file. Never commit or publish that file.
2. Create the image and run it:

```sh
docker build -t backsoon .
docker volume create backsoon-data
docker run --rm --name backsoon -p 3000:3000 --env-file .env -v backsoon-data:/data backsoon
```

Open `http://localhost:3000/embed` for the customer form and `http://localhost:3000/admin` for the dashboard. To make localhost reachable by the remote harness, use a tunnel, then enter that public URL in the harness dashboard. Or run the supplied harness locally.

The admin username is `admin`. Set `ADMIN_PASSWORD` in `.env`; otherwise the app generates a random password once and writes it to `/data/admin-password` (not to logs). To retrieve it while the container is running:

```sh
docker exec backsoon cat /data/admin-password
```

If overriding `PORT`, map the same container port, e.g. `-p 8080:8080 -e PORT=8080`. Use TLS for any public deployment: HTTP Basic credentials are not safe over plaintext. This prototype is designed for a single instance on a persistent volume, not horizontally scaled stateless containers. Place it behind rate-limiting/access control for production use.

## Environment variables

| Variable | Purpose |
|---|---|
| `STOCK_API_URL` | Full stock endpoint base, e.g. `http://harness:3000/api/stock` |
| `STOCK_API_KEY` | Stock API bearer token |
| `RESEND_API_KEY` | Email API bearer token from the harness |
| `RESEND_BASE_URL` | Harness email API base URL (the app appends `/emails`) |
| `WEBHOOK_SECRET` | Shared `X-Webhook-Secret` for stock webhooks |
| `PORT` | Listen port; defaults to 3000 |
| `ADMIN_PASSWORD` | Optional dashboard password for user `admin`; otherwise a random password is saved in the data volume |
| `DATA_DIR` | SQLite directory; defaults to `/data` in the container |
| `EMAIL_FROM` | Optional sender; defaults to a test address |

An example `.env` file (fill in the sandbox values, do not commit it):

```dotenv
STOCK_API_URL=https://harness.example/api/stock
STOCK_API_KEY=replace-me
RESEND_API_KEY=replace-me
RESEND_BASE_URL=https://harness.example
WEBHOOK_SECRET=replace-me
ADMIN_PASSWORD=choose-a-long-unique-password
```

## HTTP endpoints

- `GET /embed` — responsive, iframe-friendly email + SKU form.
- `POST /api/requests` — accepts JSON `{ "email": "...", "sku": "..." }`; an existing open request is returned rather than duplicated.
- `POST /webhooks/stock` — validates `X-Webhook-Secret`, stores the event durably, and acknowledges it.
- `GET /admin` — Basic Auth-protected request dashboard with status and notification times.
- `GET /health` — service health response.

## Reliability and data model

SQLite enforces a partial unique index on normalized email and SKU for open requests. Webhooks are stored with a unique event ID before acknowledgment, so duplicate or simultaneous deliveries do not create new event records. A background worker verifies the real stock API instead of trusting the webhook quantity. Each new signup also queues an initial stock check so an item that is already available does not wait indefinitely for a later restock event. It creates at most one durable email job per request in the same transaction that marks the event processed.

The worker retries failed API calls with backoff. Before sending it checks stock again. Each email uses a stable `Idempotency-Key` derived from the request ID, so retrying after an ambiguous network failure relies on the provider's idempotency behavior. On success, the job and notification time are updated transactionally. Pending events and jobs are recovered after process restart.

SQLite data, including the generated dashboard password, lives under `/data`. A mounted volume is required for container recreation; it also survives a restart of the same container. Back up that volume. Don't use real customer data for the challenge.

The no-duplicate guarantee depends on the email provider honoring the idempotency key; a real provider may have a limited idempotency window. No system can guarantee exactly-once external delivery across indefinite outages without a compatible provider contract and reconciliation. Delivery means accepted by the provider, not guaranteed delivered to an inbox. Suitable for the test; a production deployment needs operational monitoring, retention policy, verified sender, durable backups and an explicit scaling strategy.

## Development and validation

Node.js 24+ is required for the built-in SQLite module. To run locally, set the five challenge variables plus a writable `DATA_DIR`, then run `node server.mjs`. Run the ambiguous-email-response test with `npm test`. For the end-to-end test, first clone the challenge repo and then run:

```sh
HARNESS_PATH=/absolute/path/to/back-in-stock-challenge/harness/server.js npm run test:integration
```

The test starts local app and harness processes, creates its own sandbox account, uses only synthetic addresses, and removes its temporary data afterward. Docker must be available to verify the actual image separately. Do not use real customer data or production credentials.


## Deploying a challenge instance

A public deployment needs the five sandbox variables from the harness dashboard, a long `ADMIN_PASSWORD`, HTTPS, a public URL pointing to the service, and a **persistent volume mounted at `/data`**. Ensure the process can write to that volume. For example, Railway can build the Dockerfile; its documentation notes that volumes are mounted as root, so the service needs a compatible UID/permissions configuration. The hosted service must run continuously to process retries. After deployment, register the public URL with the harness and test a simulated signup, a duplicate webhook, stock verification, and an injected mail failure. Do not treat a URL as a completed submission until those tests actually pass.

### Railway setup

1. Create a Railway project from this GitHub repository. Choose **Add Variables** before the first deployment.
2. Add the five sandbox variables, `ADMIN_PASSWORD`, and `RAILWAY_RUN_UID=0` in the Railway service Variables tab. `RAILWAY_RUN_UID=0` is required because Railway mounts volumes as root even though the Docker image normally runs as `node`. Keep these values in Railway or a local ignored `.env`, never in Git.
3. Attach one persistent volume to the service at `/data` before deploying. Keep the service at one replica and leave `DATA_DIR=/data` (the Dockerfile default).
4. Deploy, then generate a public Railway domain in the service Networking settings. Check `https://<domain>/health`, `/embed`, and password protection on `/admin`.
5. Save that HTTPS base URL in the challenge dashboard. Use its simulator and inbox to verify restock and retry behavior. Back up the volume if you intend to retain its data.

Railway's Trial has a one-time credit and the Free plan has a small monthly allowance; a continuously running service and volume consume resources. Check [Railway pricing](https://docs.railway.com/pricing) and [volume limits](https://docs.railway.com/volumes/reference) before choosing a paid plan.
