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
- `POST /api/tasks` — body `{workspacePath, prompt, mode?, title?, modelSelection?, clientRequestId?}` → `201 {taskId}` with an optional `warning`: `first_prompt_failed` (task created but the first prompt could not be delivered — the task id is still valid and usable) or `rename_failed` (task created and prompted, but the requested `title` could not be applied). Creates a normal task in that workspace and sends the first prompt. `mode` must be one of the ZCode task modes (`default`, `guarded`, `plan`, `edit`, `acceptEdits`, `auto`, `autoEdit`, `build`, `yolo`, `dontAsk`, `bypassPermissions`) — anything else returns `400`; the enum is defined once in `@zcode/shared` and mirrors `ZCodeTaskMode`. `yolo` corresponds to the GUI's "Full access" mode (the bridging tool's default choice for dispatched tasks). **Warning: `yolo`, `dontAsk` and `bypassPermissions` reduce or disable the permission gate — tasks created in these modes can act without the GUI approval prompts that normally protect the workspace. Only use them if that is explicitly intended.** `modelSelection` (optional) picks the model for the new task — the same structured selection the GUI sends, validated by the strict `@zcode/shared` schema and passed straight through to task creation (the deprecated `model`/`thoughtLevel` fields are not used). Its shape, matching `ModelSelection`:
  ```json
  { "providerId": "glm", "modelId": "glm-4.7", "options": { "reasoningLevel": "high" } }
  ```
  `providerId` and `modelId` are non-empty strings; `options` may only contain `reasoningLevel` (a non-empty string). Anything else (unknown keys, empty strings, missing `modelId`) returns `400`. Enumerate valid values for a workspace with `GET /api/models`. `clientRequestId` (optional, 1–200 chars) is a caller-chosen idempotency key: the API remembers it for 10 minutes; a retry — including a concurrent request while the first is still in flight — returns the original `{taskId}` instead of creating a second task (failed creates are not cached, so retrying after a failure is safe).
- `POST /api/tasks/:taskId/messages` — body `{text, delivery?: "auto"|"queue"|"steer", workspacePath?, clientRequestId?}` → `202 {delivery: "sent"|"queued"|"steered", commandId}`. `clientRequestId` (optional, 1–200 chars) is an idempotency key scoped to the task, with the same semantics as on create: a 10-minute dedup window, concurrent duplicates share the in-flight response, a hit returns the first response verbatim, and failed sends are not cached. Every submission goes through the same v4 `sendText` command the GUI composer uses; the CLI input-routing owns the verdict:
  - `auto` (default) sends without a delivery override — the CLI follows the session follow-up mode, exactly like pressing Enter in the GUI while a task is running (`sent`).
  - `queue` requests queueing (`queued`).
  - `steer` requests guiding: the running turn is interrupted and the new input is injected into it, exactly like the GUI's "guide" action (`steered`). The verdict arrives on the event stream: `input.steered` (the CLI accepted the guide request; its `commandId` equals the `commandId` of this 202 response — use it for reconciliation), then `steer.injected` (injected into the current turn) or `steer.fellBack` (the CLI downgraded or rejected the guide, with a reason). `input.steered`/`steer.*` events may also originate from guide actions performed in the GUI on the same task — consumers must reconcile strictly by `commandId`. When the task is idle, a `steer` request behaves like a normal send and the response is `delivery:"sent"` (no steer events follow).
- `POST /api/tasks/:taskId/stop` → `202 {ok:true}` — equivalent to the GUI stop button.
- `GET /api/tasks/:taskId` (optional `?workspacePath=`, see routing below) → `200 {taskId, workspacePath, title, status, turnCount, lastAssistantText, updatedAt}`. `status` is one of `running | idle | waiting_permission | waiting_input | error`. `lastAssistantText` is the most recent complete assistant reply (empty string if none). `turnCount` counts assistant messages in the persisted conversation.
- `GET /api/tasks/:taskId/events?after=<seq>&waitMs=<0..30000>` → `200 {events:[...], nextSeq}` or `200 {resync:true}`. Long-poll: holds up to `waitMs` when no event newer than `after` exists. Event types: `turn.started` (with `turnId`), `assistant.message` (full text of one assistant reply), `turn.completed` (final text), `turn.failed` (with `error`; duplicate failure signals from the stream and the terminal outcome are de-duplicated within one second), `permission.requested` (with `summary` — approvals are GUI-only in this version), `input.queued` (with `commandId`; this API accepted an auto/queue input), `input.steered` (with `commandId`; the CLI accepted a guide request), `steer.injected` (the guide was injected into the running turn), `steer.fellBack` (with `error`; the CLI downgraded or rejected the guide). `seq` is per-task and monotonically increasing within one buffer lifetime. The buffer keeps the most recent 500 events per task in the owning Host's memory; ten minutes after a task reaches a terminal outcome its stream subscriptions and buffer are released entirely. A later events call lazily rebuilds an empty buffer and **restarts `seq` from 1**: a call with `after>0` from the previous buffer lifetime returns `{resync:true}` (re-read `GET /api/tasks/:taskId`, then resume from the new sequence); `after=0` simply starts following the new sequence. If the client falls behind the oldest retained event inside one buffer lifetime, the API likewise returns `{resync:true}`. Woken long-polls receive only events newer than their own `after`.
- `GET /api/tasks?workspacePath=...` → `200 {tasks:[{taskId, title, status, updatedAt}]}` (status is `running` or `idle` here).
- `GET /api/models?workspacePath=...` → `200 {providers:[...], preferred?}` — read-only. Lists the models (and their reasoning levels) selectable for **new tasks** in that workspace, from the same source the GUI's new-chat model menu uses (the owning Host's model-selection service view of the environment registry; grouped for display by `buildRegistryModelSelectGroups`, reasoning levels by `resolveModelThoughtOption` — the model display name in the GUI menu is the model id). The response is a slim projection:
  ```json
  {
    "providers": [
      {
        "providerId": "glm",
        "displayName": "智谱 GLM",
        "models": [
          { "modelId": "glm-4.7", "displayName": "glm-4.7", "thoughtLevels": ["low", "high"], "isDefault": true },
          { "modelId": "glm-4.7-air", "displayName": "glm-4.7-air", "thoughtLevels": [], "isDefault": false }
        ]
      }
    ],
    "preferred": { "providerId": "glm", "modelId": "glm-4.7", "options": { "reasoningLevel": "high" } }
  }
  ```
  `thoughtLevels` is the model's selectable reasoning-level list (empty array = the model has none). `isDefault` marks the entry the registry would use when no selection is given, and the top-level `preferred` object is that default as a ready-to-use `ModelSelection` — pass it verbatim as `modelSelection` on create if you want the default. `displayName` falls back to `providerId`/`modelId` when no display name is configured. Requires the same authentication as every other route; the workspace must be open (`409` otherwise) because the view is read in the owning Host.
- `POST /api/tasks/:taskId/model` — body `{modelSelection, workspacePath?, clientRequestId?}` → `200 {ok:true}`. Switches the model of an existing task using the same service call the task service exposes to other dispatch paths (`setModel`). `modelSelection` is required and validated like the create field (invalid → `400`); `workspacePath` is the optional re-anchoring field (see routing below); `clientRequestId` (optional, 1–200 chars) is an idempotency key scoped to the task, with the same semantics as on messages: 10-minute dedup window, concurrent duplicates share the in-flight response, a hit returns the first response verbatim, failures are not cached. Changing the model of a **running** task is allowed — the GUI likewise lets you pick another model while a task runs (the composer applies it to the next submission); the GUI only locks model selection while a Highspeed card is active, which is a UI-side state this API cannot see — if the agent side refuses the switch the call surfaces as `503 unavailable_host`. The response carries no config dump; verify the active model via `GET /api/tasks/:taskId` or the GUI if needed.

## Routing and error model

- Requests are routed to the window Host that currently owns the workspace. A workspace that is not open in any window yields `409 {"error":"workspace_not_open"}` — the API never opens workspaces on its own.
- The main process keeps an in-memory map of tasks created through this API (`taskId → workspacePath`). Every `:taskId` endpoint (messages/stop/get/events/model) also accepts an **optional `workspacePath`** — a query parameter on the GET routes, a body field on the POST routes. When the map misses (for example after an app restart) and `workspacePath` is provided, the request is routed to the Host owning that workspace, which verifies the task really belongs to it; a 2xx response back-fills the map, so subsequent requests can omit `workspacePath`. A miss without `workspacePath` returns `404 {"error":"task_not_found"}`, as does a `workspacePath` the task does not belong to. After a restart the per-task event buffer starts empty: the first events call returns no events plus the current `nextSeq`, and clients can recover full state from `GET /api/tasks/:taskId`.
- If no window Host is alive or the Host fails to answer, the API returns `503 {"error":"unavailable_host"}`; when a Host exits, its in-flight requests are settled immediately with 503 (a 300s backstop still bounds hung requests, and event long-polls are bounded by `waitMs`).
- Error codes are stable lowercase_underscore strings in the `error` field: `unauthorized`, `host_header_forbidden`, `unsupported_media_type`, `payload_too_large`, `workspace_not_open`, `task_not_found`, `unavailable_host`, `not_found`, `method_not_allowed`, `bad_request`, `internal_error`.

## Limitations

- The switch file is read once at startup. If the file is readable by group or others, ZCode logs a warning recommending `chmod 600` (startup is not blocked).
- Remote workspaces (non-empty `workspaceIdentity`) are not supported by this API in this version; they behave like unopened workspaces (`409`).
- Permission approvals are intentionally not exposed; `permission.requested` events only carry a summary, and the GUI remains the approval surface.
- There is no server-side concurrency or rate limit on task creation: each `POST /api/tasks` triggers a real agent run, so callers (bridging tools in particular) must self-limit concurrency and use `clientRequestId` to make retries safe.
- The event buffer lives in the owning window Host and is not persisted: after an app restart (or when a workspace moves to another window) the buffer starts empty — long-poll clients see no events until the next one, and should re-sync from `GET /api/tasks/:taskId` (with `?workspacePath=` on the first call after a restart).
- Nothing about outbound bot/webhook behavior changes; this API is unrelated to the Bots feature.
