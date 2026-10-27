# Desktop local webhook bot ingress

The desktop app can expose a loopback-only HTTP endpoint that accepts webhook bot inbound callbacks, so local tools can drive ZCode tasks through the same bot flow as the UI input box. The endpoint is served by the Electron main process and forwards each callback to a live window Host, where the bots service processes it exactly like the web server route does.

## Enable switch

The endpoint is opt-in through a config file read once at startup:

- Path: `<app config dir>/bot-webhook-ingress.json` (the app config dir is `~/.zcode/v2` unless a custom data directory is configured).
- Shape: `{ "enabled": true, "port": 47821 }`.
- The endpoint is not served when the file is missing, when `enabled` is not `true`, or when the file cannot be parsed or `port` is not an integer in 1–65535 (the latter two log a warning). Changing the file requires restarting the app.
- If the configured port is already in use, the app logs a warning and starts normally without the endpoint.

## Endpoint

The server binds `127.0.0.1:<port>` only. One application instance serves at most one endpoint (the main process owns it; extra windows never start a second listener).

- `GET /health` — `200 {"ok":true,"ingress":"zcode-bot-webhook","version":1,"zcodeVersion":"<app version>"}`. No authentication; no other information is exposed.
- `POST /api/bots/webhook/:botId` and `POST /api/bots/webhook` (botId in body) — request and response semantics are identical to the web server's `/api/bots/:provider` route: header `x-zcode-bot-secret`, JSON body parsed by the webhook provider (`userId`, `text`, `messageId`, optional `attachments` etc.). Responses use `responseBody ?? {ok, replies}` and pass the service status (200/400/401/503) through.
- The request body is limited to 16 MiB; larger bodies get `413`. Other methods get `405`, other paths `404`.

## Security boundary

- The listener never binds a non-loopback interface.
- POST requests must carry `Host: 127.0.0.1:<port>` or `Host: localhost:<port>`; anything else is rejected with `403` before the body is read (DNS rebinding protection).
- No CORS headers are sent; this is a machine-local service-to-service channel, not a browser API.
- Secret verification happens inside the bots service: when the bot has a webhook secret configured, a mismatching `x-zcode-bot-secret` produces the localized rejection reply instead of processing the message.
- Nothing is logged beyond request status and identifiers; bodies and secrets never reach the log.

## Relation to the web server

The web server route (`packages/server/src/http.ts`) and this endpoint share one callback handler in `@zcode/services` (`webhookCallbackHttp.ts`), which owns provider validation, body parsing, the `handleProviderCallbackResponse` call, and status mapping. Behavior differences are limited to the transport: the web server binds whatever host it is configured with, while the desktop endpoint is loopback-only, gated by the config file, Host-header-checked, and size-capped.

## Limitations

- The switch file is read once at startup; toggling it requires an app restart.
- When no window Host is alive (for example right after startup, or on macOS with all windows closed while the app keeps running), POSTs return `503` until a Host is available again.
- Outbound webhook behavior (ZCode posting replies to the bot's `webhookUrl`) is unchanged and works whether or not the ingress endpoint is enabled.
