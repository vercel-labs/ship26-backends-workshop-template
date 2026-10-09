# backend: your agent goes here

This directory is the `backend` service in [`../vercel.json`](../vercel.json).
Every request to `/api/*` on your deployment is routed here, and the path is
kept as is: a call to `/api/agent/chat` reaches your code as `/api/agent/chat`.

Your job is to build an agent that takes chat messages from the UI, decides what
to do, and drives your character through the game server's API.

```
browser (ui/) ──/api/agent/*──▶ your backend ──/game/controls/spawn, move, say──▶ game server
                                    │
                                    ├──▶ an LLM (e.g. via AI Gateway)
                                    └──▶ memory (Neon Postgres)
```

## 1. Routes the UI calls

Implement these three. Every call except `GET /api/agent` carries the login
session as headers:

| Header | Meaning |
| --- | --- |
| `X-Game-URL` | Base URL of the game server, e.g. `https://game.example.com` |
| `X-Player-Secret` | The character's secret, issued by the game server. Forward it as `Authorization: Bearer <secret>`. Missing only when logging in as a new character. |
| `X-Player-Id` | The character's id, once it exists. Handy for keying your own data. |
| `X-Player-Name` | Name for a new character (`[A-Za-z0-9_-]{1,24}`), sent only to `connect` when there's no secret. |

The secret is the character: the game server identifies players by it alone,
and the name is just a label (two players can share one). The backend can stay
stateless: the browser stores the session, the characters you've played, and
one chat history per character, and sends the current one with every request.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/agent` | none | `{"model": "<model id>"}`, shown in the chat header |
| POST | `/api/agent/connect` | session headers | Call the game's `/game/controls/spawn` with the secret if there is one, or else with the name, then return `{"player_id", "name", "secret", "game_url"}`. The browser keeps that `secret`. On failure return a non-2xx status with `{"detail": "<message>"}`; the login screen shows it. |
| POST | `/api/agent/chat` | session headers, body `{"messages": [UIMessage, ...]}` (AI SDK `useChat`) | One agent turn, streamed as an [AI SDK UI message stream](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) (SSE). |

The UI renders text parts as chat lines and tool parts as `▸ move("up", 3) → applied at 25,23 · walked 3`.
If your tool outputs are the game server's receipts (see below), that summary
works without changes.

## 2. The game server API

Your agent's tools call these, on the game URL (`X-Game-URL`) plus the path:
e.g. `https://game.example.com/game/controls/move`. Every action request except
your very first spawn needs `Authorization: Bearer <player secret>`.

| Method | Path | Body | Does |
| --- | --- | --- | --- |
| POST | `/game/controls/spawn` | `{"name": "Explorer"}` (not needed with a secret) | Create or claim your character. No secret: a new character, and the reply carries its `secret`. With the secret: that character again (back on the map if it left). Returns `player_id`, `name`, and `secret` too. |
| POST | `/game/controls/move` | `{"direction": "up" \| "down" \| "left" \| "right", "steps": 3}` | Walk `steps` tiles (1-5, default 1) in a straight line, one tile per tick. |
| POST | `/game/controls/say` | `{"phrase": "Praise ****!", "word": "coffee"}` | Post to the shared chat in the game's vocabulary (see below). |
| GET | `/game/controls/vocabulary` | none | Every phrase and word `say` accepts, plus a `version`. No auth needed. |
| GET | `/game/controls/screenshot` | none | A PNG of the whole game right now: map, players, speech bubbles, chat. No auth needed. |

How actions work:

- The game ticks a couple of times per second. Actions are queued and applied
  together on the next tick. The request blocks until its tick lands, then
  returns a receipt:

  ```json
  {"id": "…", "kind": "move", "status": "applied", "tick": 812,
   "result": {"moved": 3, "x": 25, "y": 26, "xp": 10, "checkpoint": "Main Stage"}}
  ```

- A move with `steps` walks one tile per tick and returns once the walk ends;
  `result.moved` says how many tiles you walked. Long walks save your model
  round trips: one call for five tiles instead of five.
- `status` is `applied`, `rejected`, or `pending` (HTTP 202) if the tick took
  unusually long. A wall or the map edge stops a walk early and sets
  `result.error` (`obstacle` or `out_of_bounds`); it's `rejected` only if it
  didn't take a single step.
- Rate limit: each player gets one pending move and one pending say at a time.
  You can walk and talk at the same time, but a second move before the first
  one (or its whole walk) lands gets `429` (with `Retry-After: 1`). Run tool
  calls one after another, not in parallel.
- Other errors: `401` for a missing or unknown player secret, `422` for an
  invalid body. Spawn before you move or say.
- Chat is Dark Souls style: there is no free text. A message is one `phrase`
  from `GET /game/controls/vocabulary`. A phrase with a `****` slot takes exactly one
  `word` from the same listing; other phrases take none. Case doesn't matter.
  Anything else gets `422`. Put the vocabulary in your system prompt so the
  model knows what it can say.
- There is no JSON world state. To see where you are, who's around, and what
  people are saying, give your model the screenshot. Tile `(x, y)` starts at
  pixel `((x + 1) * 32, (y + 3) * 32 + 44)`.
- The map hides secret zones. The first visit to each one earns XP.

Tip: return errors to the model as data (e.g. `{"error": 429, "detail": "…"}`)
instead of raising, so it can see what went wrong and try something else.

## 3. Building it

Use any language Vercel can run. We recommend Python, and the walkthrough
below uses it, but Go, Rust, TypeScript, or a container all work.

### Python (recommended)

Use FastAPI and [AI SDK for Python](https://ai-python.dev/docs) (the `ai`
package). It has tool calling, an agent loop, and an adapter that turns
`useChat` messages into agent messages and agent events into the UI stream.

1. Create `backend/pyproject.toml` and tell Vercel where the app is:

   ```toml
   [project]
   name = "workshop-agent"
   version = "0.1.0"
   requires-python = ">=3.12"
   dependencies = ["ai[vercel]", "fastapi", "httpx"]

   [tool.vercel]
   entrypoint = "app.server:app"
   ```

   Then add `"entrypoint": "pyproject.toml"` to the `backend` service in
   `vercel.json`.

2. Write a small game client with `httpx` that sends
   `Authorization: Bearer <secret>` (skip it when there's no secret yet).
3. Wrap `move` and `say` as tools and run them in an agent. Roughly:

   ```python
   from typing import Literal

   import ai
   from ai.ui import ai_sdk
   from fastapi.responses import StreamingResponse

   @ai.tool
   async def move(
       direction: Literal["up", "down", "left", "right"], steps: Literal[1, 2, 3, 4, 5] = 1
   ) -> dict:
       """Walk 1-5 tiles. Returns the game's receipt with tiles moved, new x, y and xp."""
       return await game.act("/game/controls/move", {"direction": direction, "steps": steps})

   @ai.tool
   async def say(phrase: str, word: str | None = None) -> dict:
       """Say one vocabulary phrase; add a word only if it has a **** slot."""
       body = {"phrase": phrase} if word is None else {"phrase": phrase, "word": word}
       return await game.act("/game/controls/say", body)

   class GameAgent(ai.Agent):
       TOOLS = [move, say]

   @app.post("/api/agent/chat")
   async def chat(request: ChatRequest):
       history, _ = ai_sdk.to_messages(request.messages, tools=GameAgent.TOOLS)
       messages = [ai.system_message(SYSTEM_PROMPT), *history]
       model = ai.get_model("anthropic/claude-haiku-4.5")

       async def body():
           async with GameAgent().run(model, messages) as stream:
               async for chunk in ai_sdk.to_sse(stream):
                   yield chunk

       return StreamingResponse(body(), headers=ai_sdk.UI_MESSAGE_STREAM_HEADERS)
   ```

   The tools need the session from the request headers. A `contextvars.ContextVar`
   set in a FastAPI dependency is one way to pass it. Use an `async`
   dependency so the value is still there when the stream runs.

4. Models: `ai.get_model(...)` goes through [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).
   Deployments authenticate with the project's OIDC token. Locally, run
   `vercel env pull` first. For tests and offline work, `ai.testing.FakeModel`
   replays a scripted conversation.

### Other languages

Any runtime works as long as it serves the three routes above:

- Set `entrypoint` (or `framework`) on the `backend` service in `vercel.json` if
  Vercel doesn't detect it. See the [Services config reference](https://vercel.com/docs/services/config-reference).
- Handle the full `/api/agent/...` path; the `/api` prefix isn't stripped.
- For `/api/agent/chat`, respond with `Content-Type: text/event-stream` and
  `x-vercel-ai-ui-message-stream: v1`, then stream `data: {json}` events. A
  minimal turn looks like this:

  ```
  data: {"type":"start"}
  data: {"type":"start-step"}
  data: {"type":"tool-input-available","toolCallId":"c1","toolName":"move","input":{"direction":"up"}}
  data: {"type":"tool-output-available","toolCallId":"c1","output":{"status":"applied","result":{"moved":1,"x":3,"y":4,"xp":0}}}
  data: {"type":"finish-step"}
  data: {"type":"start-step"}
  data: {"type":"text-start","id":"t1"}
  data: {"type":"text-delta","id":"t1","delta":"Moved up!"}
  data: {"type":"text-end","id":"t1"}
  data: {"type":"finish-step"}
  data: {"type":"finish"}
  data: [DONE]
  ```

  (Separate events with a blank line, as SSE requires.)
- To call models, use AI Gateway's OpenAI-compatible API or any provider SDK.

## 4. Memory with Neon Postgres

The chat history lives in the browser, so anything the agent should remember
on its own (zones found, players met, notes) needs a database. Add one from the
Vercel Marketplace:

```sh
vercel integration add neon
vercel env pull          # puts DATABASE_URL in .env.local for vercel dev
```

Your backend reads `DATABASE_URL` (pooled; good for serverless). Key your rows
by player id (`X-Player-Id`), not name, so each character gets its own memory
(names can repeat), and give the agent tools to read and write it.

## 5. Ideas once it works

- React to what others say in the chat (look at the screenshot).
- Give the model the screenshot so it can navigate (multimodal).
- Hunt for the secret zones to earn XP.
- Keep playing without you, for example on a schedule.
- Run long, durable sessions with [Vercel Workflow](https://workflow-sdk.dev/docs/getting-started/python).

## Docs

- [Vercel Services](https://vercel.com/docs/services) and the [config reference](https://vercel.com/docs/services/config-reference)
- Runtimes: [Python](https://vercel.com/docs/functions/runtimes/python), [Go](https://vercel.com/docs/functions/runtimes/go), [Rust](https://vercel.com/docs/functions/runtimes/rust), [Node.js](https://vercel.com/docs/functions/runtimes/node-js)
- [AI SDK for Python](https://ai-python.dev/docs) and its [AI SDK UI adapter](https://ai-python.dev/docs/basics/ai-sdk-ui.md)
- [AI SDK UI stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)
- [Neon on Vercel](https://vercel.com/marketplace/neon)
