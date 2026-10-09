// The login session and the characters you've played live in localStorage, the
// usual place for a single-page app's credentials. The session is sent to our
// agent API as headers on every request; the agent uses it to talk to the game
// server. Not hardened: workshop only.
//
// The game server issues each character's secret on its first spawn. The secret
// is the character: keep it to reconnect, lose it and you start over. The name
// is only a label, set at creation. Each character gets its own chat history.

import type { UIMessage } from "ai";

/** A character you can play again: the secret is all the game needs. */
export type Character = {
  gameUrl: string;
  playerId: string;
  name: string;
  secret: string;
};

/** The active login: the character being played. */
export type Session = Character;

/** What the login screen sends: a secret claims a character, a name creates one. */
export type Login = {
  gameUrl: string;
  name?: string;
  secret?: string;
  playerId?: string;
};

const SESSION_KEY = "game-session-v2";
const LOGIN_KEY = "game-login-v1";
const CHARACTERS_KEY = "game-characters-v1";
const HISTORY_PREFIX = "agent-chat-v3:";
// Before the server issued secrets: one browser-made secret, one shared history.
for (const key of ["game-session-v1", "player-secret-v1", "agent-chat-v2"]) {
  localStorage.removeItem(key);
}

function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

export const sameServer = (a: string, b: string) =>
  a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

export function loadSession(): Session | null {
  // Older sessions may still carry a `password`; drop it.
  const session = read<Session | null>(SESSION_KEY, null);
  if (!session?.gameUrl || !session?.secret || !session?.playerId) return null;
  const { gameUrl, playerId, name, secret } = session;
  return { gameUrl, playerId, name, secret };
}

/** Make this the active session and remember its character. */
export function saveSession(session: Session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  const others = loadCharacters().filter((c) => c.playerId !== session.playerId);
  localStorage.setItem(CHARACTERS_KEY, JSON.stringify([session, ...others]));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/** The login form's last server and name, kept across logouts. */
export type LoginFields = { gameUrl: string; name: string };

export function loadLoginFields(): LoginFields {
  // Pick the known fields: older saves may still carry a `password`.
  const { gameUrl = "", name = "" } = read<Partial<LoginFields>>(LOGIN_KEY, {});
  return { gameUrl, name };
}

export function saveLoginFields(fields: LoginFields) {
  localStorage.setItem(LOGIN_KEY, JSON.stringify(fields));
}

/** Characters played in this browser, most recent first. */
export function loadCharacters(gameUrl?: string): Character[] {
  const all = read<Character[]>(CHARACTERS_KEY, []);
  return gameUrl === undefined ? all : all.filter((c) => sameServer(c.gameUrl, gameUrl));
}

const historyKey = (c: Pick<Character, "gameUrl" | "playerId">) =>
  `${HISTORY_PREFIX}${c.gameUrl}:${c.playerId}`;

export function loadHistory(c: Character): UIMessage[] {
  return read<UIMessage[]>(historyKey(c), []);
}

export function saveHistory(c: Character, messages: UIMessage[]) {
  localStorage.setItem(historyKey(c), JSON.stringify(messages.slice(-200)));
}

export function sessionHeaders(s: Login): Record<string, string> {
  const headers: Record<string, string> = { "X-Game-URL": s.gameUrl };
  if (s.secret) headers["X-Player-Secret"] = s.secret;
  else if (s.name) headers["X-Player-Name"] = s.name;
  if (s.playerId) headers["X-Player-Id"] = s.playerId;
  return headers;
}

/** Log in: the agent API spawns (creates or claims) the character. */
export async function connect(login: Login): Promise<Session> {
  const response = await fetch("/api/agent/connect", {
    method: "POST",
    headers: sessionHeaders(login),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return {
    gameUrl: data.game_url,
    playerId: data.player_id,
    name: data.name,
    secret: data.secret,
  };
}
