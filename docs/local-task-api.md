# Desktop local task API

The desktop app can expose a loopback-only HTTP API that lets local tools drive ordinary ZCode desktop conversations: creating tasks, appending input while a task is running, stopping generation, and observing coarse-grained events. Tasks created through this API are regular desktop tasks — they appear in the GUI task list immediately, can run in parallel, and can be taken over in the GUI at any time.

The HTTP endpoint is served by the Electron main process (one listener per app instance). Each request is routed to the window Host that owns the workspace and executed against that Host's task service — the same service face used by headless dispatch paths.

## Enable switch

Opt-in via a config file read once at startup:

- Path: `<app config dir>/local-task-api.json` (`~/.zcode/v2` unless a custom data directory is configured). The file is written by the user or by the bridging tool's setup (permission 0600 recommended); ZCode only reads it.
- Shape: `{ "enabled": true, "port": 47821, "token": "<random string, at least 32 chars>" }`.
- The API is not served when the file is missing, `enabled` is not `true`, the file cannot be parsed, `port` is not an integer in 1–65535, or `token` is shorter than 32 characters (the latter cases log a warning). Changing the file requires an app restart.
- If the port is already in use, the app logs a warning and starts normally without the API.

## Authentication and transport rules

- `GET /health` is the only unauthenticated route.
- Every other request must carry `Authorization: Bearer <token>` (constant-time comparison); otherwise `401`.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding protection); otherwise `403` before the body is read.
- Request bodies must be `Content-Type: application/json`; otherwise `415`. Bodies are capped at 16 MiB (`413`). No CORS headers are ever sent.
- Unknown paths return `404`; other methods `405`.

## Endpoints

- `GET /health` → `200 {"ok":true,"api":"zcode-local-task-api","version":2,"zcodeVersion":"<app version>"}`.
- `POST /api/tasks` — body `{workspacePath, prompt, mode?, title?}` → `201 {taskId}`. Creates a normal task in that workspace and sends the first prompt. `mode` defaults to the same default as a GUI-created conversation. `title` renames the task after creation.
- `POST /api/tasks/:taskId/messages` — body `{text, delivery?: "auto"|"queue"|"steer"}` → `202 {delivery: "sent"|"queued"|"steered", commandId?}`. When the task is idle the text is sent directly (`sent`); when it is running the text is enqueued (`auto`/`queue` → `queued`), and `steer` additionally promotes the queued command to interrupt-and-resume semantics (`steered`).
- `POST /api/tasks/:taskId/stop` → `202 {ok:true}` — equivalent to the GUI stop button.
- `GET /api/tasks/:taskId` → `200 {taskId, workspacePath, title, status, turnCount, lastAssistantText, updatedAt}`. `status` is one of `running | idle | waiting_permission | waiting_input | error`. `lastAssistantText` is the most recent complete assistant reply (empty string if none). `turnCount` counts assistant messages in the persisted conversation.
- `GET /api/tasks/:taskId/events?after=<seq>&waitMs=<0..30000>` → `200 {events:[...], nextSeq}` or `200 {resync:true}`. Long-poll: holds up to `waitMs` when no event newer than `after` exists. Event types: `turn.started` (with `turnId`), `assistant.message` (full text of one assistant reply), `turn.completed` (final text), `turn.failed` (with `error`), `permission.requested` (with `summary` — approvals are GUI-only in this version), `input.queued` / `input.steered` (with `commandId`, emitted when this API accepted a queued/steered input). `seq` is per-task and monotonically increasing. The buffer keeps the most recent 500 events per task in the owning Host's memory; if the client falls behind the oldest retained event, the API returns `{resync:true}` and the client should re-read `GET /api/tasks/:taskId`.
- `GET /api/tasks?workspacePath=...` → `200 {tasks:[{taskId, title, status, updatedAt}]}` (status is `running` or `idle` here).

## Routing and error model

- Requests are routed to the window Host that currently owns the workspace. A workspace that is not open in any window yields `409 {"error":"workspace_not_open"}` — the API never opens workspaces on its own.
- The main process keeps an in-memory map of tasks created through this API (`taskId → workspacePath`). After an app restart, operations on task ids created before the restart return `404 {"error":"task_not_found"}`; create a new task instead. Unknown task ids get the same response.
- If no window Host is alive or the Host fails to answer, the API returns `503 {"error":"unavailable_host"}` (a dispatcher-level 300s backstop bounds hung requests; event long-polls are bounded by `waitMs`).
- Error codes are stable lowercase_underscore strings in the `error` field: `unauthorized`, `host_header_forbidden`, `unsupported_media_type`, `payload_too_large`, `workspace_not_open`, `task_not_found`, `unavailable_host`, `not_found`, `method_not_allowed`, `bad_request`.

## Limitations

- The switch file is read once at startup.
- Remote workspaces (non-empty `workspaceIdentity`) are not supported by this API in this version; they behave like unopened workspaces (`409`).
- Permission approvals are intentionally not exposed; `permission.requested` events only carry a summary, and the GUI remains the approval surface.
- The event buffer lives in the owning window Host. If a workspace moves to another window after a task was created, the new Host's buffer starts empty and clients receive `{resync:true}` until they re-sync from the task snapshot.
- Nothing about outbound bot/webhook behavior changes; this API is unrelated to the Bots feature.
