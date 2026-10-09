# Ship 26 backends workshop: your game agent

You build the agent that plays your character in the shared workshop game, then
deploy it to Vercel. The UI is done. The backend is up to you.

| Path | What |
| --- | --- |
| `ui/` | Supplied UI (Vite + React + AI SDK `useChat`): a login screen and a chat with your agent. You don't need to change it. |
| `backend/` | Empty. Your agent goes here. Start with [`backend/README.md`](./backend/README.md). |
| `vercel.json` | [Vercel Services](https://vercel.com/docs/services) (beta): `ui` and `backend` ship as one deployment. `/api/*` goes to `backend`, everything else goes to `ui`. |

## Getting started

1. Read [`backend/README.md`](./backend/README.md) and build the three routes
   the UI calls.
2. Run it locally. This starts both services:

   ```sh
   vercel dev
   ```

3. Open the app and log in with the game server URL and a character name. The game server hands back your character's secret; the
   UI keeps it, so you can come back to the same character (and its chat)
   later by picking it under "existing character secret".
4. Deploy:

   ```sh
   vercel deploy --prod
   ```

Until `backend/` has code in it, `vercel dev` and deployments will fail.
