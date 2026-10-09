// Supplied UI: a login screen, then a chat with your agent built on AI SDK's
// useChat. The chat only shows this conversation (your messages, the agent's
// replies and its tool calls as they stream in), not the shared world. Session,
// characters and their histories live in localStorage, one history per
// character; the backend is stateless and gets the session (headers) and that
// character's whole history with every message.

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from "ai";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  type Character,
  type LoginFields,
  type Session,
  clearSession,
  connect,
  loadCharacters,
  loadHistory,
  loadLoginFields,
  loadSession,
  saveHistory,
  saveLoginFields,
  saveSession,
  sessionHeaders,
} from "./session";

type Info = { model: string };
type ToolPart = Extract<ReturnType<typeof asTool>, object>;

const asTool = (part: UIMessage["parts"][number]) => (isToolUIPart(part) ? part : null);

/** Summarise a game action receipt (or an HTTP error) from the tool output. */
function describe(output: unknown): { text: string; ok: boolean } {
  const r = (output ?? {}) as Record<string, any>;
  if (typeof r.error === "number") return { text: `error ${r.error}: ${r.detail}`, ok: false };
  const res = r.result ?? {};
  const at = typeof res.x === "number" ? ` at ${res.x},${res.y}` : "";
  // Walks: how far you got, and what stopped you early (rejected: no step at all).
  const walked = typeof res.moved === "number" && res.moved > 1 ? `walked ${res.moved}` : "";
  const stopped = res.error ? (r.status === "rejected" ? res.error : `stopped: ${res.error}`) : "";
  const walk = [walked, stopped].filter(Boolean).join(", ");
  const zones: string[] = res.checkpoints ?? (res.checkpoint ? [res.checkpoint] : []);
  const found = zones.length ? ` · found ${zones.join(", ")}! ${res.xp} XP` : "";
  return {
    text: `${r.status ?? "done"}${at}${walk ? ` · ${walk}` : ""}${found}`,
    ok: r.status !== "rejected",
  };
}

function ToolLine({ part }: { part: ToolPart }) {
  const args = Object.values((part.input ?? {}) as Record<string, unknown>)
    .map((v) => JSON.stringify(v))
    .join(", ");
  let result = { text: "…", ok: true };
  if (part.state === "output-available") result = describe(part.output);
  else if (part.state === "output-error") result = { text: part.errorText, ok: false };
  return (
    <>
      <p className="tool">
        <span className="tool-call">{`▸ ${getToolName(part)}(${args})`}</span>
      </p>
      <p className={`tool ${result.ok ? "" : "tool-bad"}`}>{`  → ${result.text}`}</p>
    </>
  );
}

type Gate =
  | { state: "checking"; stored: Session }
  | { state: "login"; error?: string }
  | { state: "in"; session: Session };

/** Reuse a stored session if the game still accepts it; otherwise show the login. */
export function App() {
  const [gate, setGate] = useState<Gate>(() => {
    const stored = loadSession();
    return stored ? { state: "checking", stored } : { state: "login" };
  });

  useEffect(() => {
    if (gate.state !== "checking") return;
    let cancelled = false;
    connect(gate.stored)
      .then((session) => {
        if (cancelled) return;
        saveSession(session);
        setGate({ state: "in", session });
      })
      .catch((e: Error) => {
        if (!cancelled) setGate({ state: "login", error: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [gate]);

  if (gate.state === "checking") {
    return (
      <main className="pixel-panel login">
        <p className="muted">{`Reconnecting to ${gate.stored.gameUrl}…`}</p>
      </main>
    );
  }
  if (gate.state === "login") {
    return (
      <Login
        initialError={gate.error}
        onLogin={(session) => {
          saveSession(session);
          setGate({ state: "in", session });
        }}
      />
    );
  }
  return (
    <Chat
      // One chat per character: switching characters starts from its own history.
      key={gate.session.playerId}
      session={gate.session}
      onLogout={() => {
        clearSession();
        setGate({ state: "login" });
      }}
    />
  );
}

/** Server and a name for a new character; or, below the line, the
 * secret of an existing one, which hides the name. */
function Login({
  initialError,
  onLogin,
}: {
  initialError?: string;
  onLogin: (session: Session) => void;
}) {
  const [fields, setFields] = useState(loadLoginFields);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState(initialError ?? null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof LoginFields) => (e: ChangeEvent<HTMLInputElement>) =>
    setFields({ ...fields, [key]: e.target.value });
  const claiming = secret.trim() !== "";
  // Characters remembered for the typed server, or all of them while it's blank.
  const saved = loadCharacters(fields.gameUrl.trim() || undefined);
  const picked = saved.find((c) => c.secret === secret.trim());

  return (
    <main className="pixel-panel login">
      <h1>JOIN THE GAME</h1>
      <form
        className="login-form"
        onSubmit={(event) => {
          event.preventDefault();
          const login = { ...fields, gameUrl: fields.gameUrl.trim(), name: fields.name.trim() };
          saveLoginFields(login);
          setBusy(true);
          setError(null);
          connect(claiming ? { ...login, secret: secret.trim() } : login)
            .then(onLogin)
            .catch((e: Error) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          <span>Server URL</span>
          <input
            type="url"
            required
            autoFocus={!fields.gameUrl}
            placeholder="https://…"
            value={fields.gameUrl}
            onChange={set("gameUrl")}
          />
        </label>
        {!claiming && (
          <label>
            <span>Character name</span>
            <input
              required
              autoFocus={!!fields.gameUrl}
              maxLength={24}
              pattern="[A-Za-z0-9_\-]+"
              title="Letters, digits, _ and -"
              placeholder="Explorer"
              value={fields.name}
              onChange={set("name")}
            />
          </label>
        )}
        <p className="login-or">or</p>
        <label>
          <span>
            Existing character secret
            {picked && <span className="login-picked">{` · ${picked.name}`}</span>}
          </span>
          <SecretField value={secret} onChange={setSecret} characters={saved} />
        </label>
        {error && <p className="msg-error">{`⚠ ${error}`}</p>}
        <button className="pixel-button" disabled={busy}>
          {busy ? "CONNECTING…" : "PLAY"}
        </button>
      </form>
    </main>
  );
}

/** A text field for the secret with a dropdown of remembered characters,
 * labelled by name since nobody remembers a secret. */
function SecretField({
  value,
  onChange,
  characters,
}: {
  value: string;
  onChange: (secret: string) => void;
  characters: Character[];
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = value.trim();
  const query = typed.toLowerCase();
  const options = characters.filter(
    (c) => !query || c.name.toLowerCase().includes(query) || c.secret.startsWith(typed),
  );
  const shown = open && options.length > 0;
  const pick = (c: Character) => {
    onChange(c.secret);
    setOpen(false);
  };

  return (
    <div className="combo">
      <input
        role="combobox"
        aria-expanded={shown}
        aria-controls="saved-characters"
        aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? `saved-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={characters.length ? "paste or pick one" : "paste it here"}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (i + step + options.length) % options.length);
          } else if (e.key === "Enter" && shown && active >= 0) {
            e.preventDefault();
            pick(options[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {characters.length > 0 && (
        <button
          type="button"
          className="combo-toggle"
          tabIndex={-1}
          aria-label="Saved characters"
          onMouseDown={(e) => {
            e.preventDefault(); // keep focus in the input
            setOpen(!open);
          }}
        >
          {shown ? "▴" : "▾"}
        </button>
      )}
      {shown && (
        <ul className="combo-list" role="listbox" id="saved-characters">
          {options.map((c, i) => (
            <li
              key={c.playerId}
              id={`saved-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
            >
              <span className="combo-name">{c.name}</span>
              <span className="combo-secret">{`${c.secret.slice(0, 10)}…`}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Chat({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const log = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent/chat",
        // The secret is the character; the name was settled at login.
        headers: sessionHeaders({ ...session, name: undefined }),
      }),
    // The chat is remounted per character, so the credentials are fixed for its lifetime.
    [],
  );
  const { messages, sendMessage, setMessages, status, error, clearError } = useChat({
    transport,
    messages: useMemo(() => loadHistory(session), []),
  });
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    fetch("/api/agent")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setInfo)
      .catch((e: Error) => setInfoError(e.message));
  }, []);

  // Persist once a turn settles; streaming updates are too frequent to write.
  useEffect(() => {
    if (!busy) saveHistory(session, messages);
  }, [messages, busy, session]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages, status, error]);

  const name = session.name;

  return (
    <main className="pixel-panel chat">
      <header className="chat-head">
        <div className="chat-who">
          <strong>{name}</strong>
          <span className="muted">
            {infoError
              ? `backend unavailable (${infoError})`
              : info
                ? `model: ${info.model}`
                : "connecting…"}
          </span>
        </div>
        <button
          className="pixel-button"
          title="Copy your character's secret: it's the only way to play it again"
          onClick={() => {
            void navigator.clipboard.writeText(session.secret).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "COPIED" : "SECRET"}
        </button>
        <button
          className="pixel-button"
          title="Log out (this browser keeps the character)"
          disabled={busy}
          onClick={onLogout}
        >
          LOG OUT
        </button>
        <button
          className="pixel-button"
          title="Clear chat history"
          disabled={busy}
          onClick={() => {
            setMessages([]);
            clearError();
          }}
        >
          CLEAR
        </button>
      </header>

      <div
        className="chat-log"
        ref={log}
        role="log"
        aria-label="Chat with your agent"
        aria-live="polite"
        tabIndex={0}
      >
        {messages.length === 0 && (
          <p className="muted empty">Say anything. Your agent will do something about it.</p>
        )}
        {messages.map((message) =>
          message.parts.map((part, i) => {
            const key = `${message.id}-${i}`;
            if (isTextUIPart(part)) {
              if (!part.text) return null;
              return message.role === "user" ? (
                <p className="msg msg-user" key={key}>
                  <span className="msg-name">YOU</span>
                  <span className="msg-text">{part.text}</span>
                </p>
              ) : (
                <p className="msg msg-agent" key={key}>
                  <span className="msg-name">{name}</span>
                  <span className="msg-text">{part.text}</span>
                </p>
              );
            }
            const tool = asTool(part);
            return tool ? <ToolLine part={tool} key={key} /> : null;
          }),
        )}
        {status === "submitted" && <p className="muted thinking">…</p>}
        {error && <p className="msg msg-error">{`⚠ ${error.message}`}</p>}
      </div>

      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          const text = input.trim();
          if (!text || busy) return;
          setInput("");
          clearError();
          void sendMessage({ text });
        }}
      >
        <input
          autoFocus
          autoComplete="off"
          maxLength={2000}
          placeholder="Tell your agent what to do…"
          aria-label="Message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="pixel-button" disabled={busy || !input.trim()}>
          SEND
        </button>
      </form>
    </main>
  );
}
