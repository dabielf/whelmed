import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

type Action = {
  id: string;
  text: string;
  status: "planned" | "done";
  created_at: string;
};

type Value = {
  id: string;
  name: string;
  meaning: string | null;
  position: number;
  actions: Action[];
};

type Today = {
  date: string;
  values: Value[];
};

type Route = "today" | "values" | "goals" | "history" | "settings";

const navigation: { route: Route; label: string }[] = [
  { route: "today", label: "Today" },
  { route: "values", label: "Values" },
  { route: "goals", label: "Goals" },
  { route: "history", label: "History" },
  { route: "settings", label: "Settings" },
];

const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function routeFromPath(): Route {
  const route = window.location.pathname.split("/").filter(Boolean)[0];
  return navigation.some((item) => item.route === route)
    ? (route as Route)
    : "today";
}

async function api<T>(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("x-time-zone", browserTimeZone);
  if (options.body) headers.set("content-type", "application/json");

  const response = await fetch(path, { ...options, headers });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Whelmed could not save that.");
  return body;
}

function formattedDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    weekday: "long",
  }).format(new Date(`${date}T12:00:00`));
}

function Brand() {
  return (
    <a className="brand" href="/today">
      <img src="/brand/whelmed-mascot-transparent.png" alt="" />
      <span>Whelmed.</span>
    </a>
  );
}

function Shell({
  children,
  date,
  route,
  navigate,
}: {
  children: React.ReactNode;
  date?: string;
  route: Route;
  navigate: (route: Route) => void;
}) {
  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <nav className="navigation" aria-label="Main navigation">
          {navigation.map((item) => (
            <a
              aria-current={route === item.route ? "page" : undefined}
              href={`/${item.route}`}
              key={item.route}
              onClick={(event) => {
                event.preventDefault();
                navigate(item.route);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <span className="topbar-date">{date ? formattedDate(date) : ""}</span>
      </header>
      {children}
    </div>
  );
}

function TodayPage({
  data,
  loading,
  openAction,
  navigate,
}: {
  data?: Today;
  loading: boolean;
  openAction: (value: Value) => void;
  navigate: (route: Route) => void;
}) {
  return (
    <main className="page today-page">
      <header className="page-heading">
        <p className="eyebrow">Today</p>
        <h1>Today’s actions</h1>
        <p>Keep your Values close. Add what fits today.</p>
      </header>

      {loading ? (
        <p className="notice" aria-live="polite">Loading Today…</p>
      ) : !data?.values.length ? (
        <section className="empty-card">
          <h2>Start with one Value</h2>
          <p>A Value is a direction you want to express in how you act.</p>
          <button className="primary-button" onClick={() => navigate("values")}>
            Create a Value
          </button>
        </section>
      ) : (
        <section className="daily-log" aria-labelledby="daily-log-title">
          <div className="section-heading">
            <h2 id="daily-log-title">Daily log</h2>
          </div>
          {data.values.map((value) => (
            <article className="value-section" key={value.id}>
              <header className="value-heading">
                <div>
                  <h3>{value.name}</h3>
                  <p>
                    {value.actions.some((action) => action.status === "done")
                      ? "A Done action is here."
                      : value.actions.length
                        ? "An action is planned."
                        : "No action yet."}
                  </p>
                </div>
                <button className="quiet-button" onClick={() => openAction(value)}>
                  Add action
                </button>
              </header>

              {value.actions.length > 0 && (
                <ul className="action-list">
                  {value.actions.map((action) => (
                    <li className="action-row" key={action.id}>
                      <span className={`state-mark ${action.status}`} aria-hidden="true">
                        {action.status === "done" ? "✓" : "○"}
                      </span>
                      <span>{action.text}</span>
                      <span className="state-label">
                        {action.status === "done" ? "Done" : "Planned"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </section>
      )}
    </main>
  );
}

function ValuesPage({
  data,
  createValue,
}: {
  data?: Today;
  createValue: (name: string, meaning: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [meaning, setMeaning] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await createValue(name, meaning);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the Value.");
      setSaving(false);
    }
  }

  return (
    <main className="page narrow-page">
      <header className="page-heading">
        <p className="eyebrow">Values</p>
        <h1>Create a Value</h1>
        <p>Choose a short name. Add what it means to you if that helps.</p>
      </header>

      <form className="form-card" onSubmit={submit}>
        <label className="field">
          <span>Short name</span>
          <input
            autoFocus
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="For example: Care"
            required
            value={name}
          />
        </label>
        <label className="field">
          <span>Personal meaning <small>Optional</small></span>
          <textarea
            maxLength={500}
            onChange={(event) => setMeaning(event.target.value)}
            placeholder="What does this Value mean in your life?"
            rows={4}
            value={meaning}
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={saving} type="submit">
          {saving ? "Creating…" : "Create Value"}
        </button>
      </form>

      {data?.values.length ? (
        <section className="saved-values" aria-labelledby="saved-values-title">
          <h2 id="saved-values-title">Active Values</h2>
          <ul>
            {data.values.map((value) => (
              <li key={value.id}>
                <strong>{value.name}</strong>
                {value.meaning && <span>{value.meaning}</span>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

function PlaceholderPage({ route }: { route: Exclude<Route, "today" | "values"> }) {
  const text = {
    goals: ["Goals", "Friendly finish lines will live here."],
    history: ["History", "Past Done actions will live here."],
    settings: ["Settings", "App choices will live here."],
  }[route];

  return (
    <main className="page narrow-page placeholder-page">
      <p className="eyebrow">{text[0]}</p>
      <h1>{text[0]}</h1>
      <p>{text[1]} This part comes later.</p>
    </main>
  );
}

function ActionDialog({
  value,
  close,
  save,
}: {
  value?: Value;
  close: () => void;
  save: (value: Value, text: string, done: boolean) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const actionInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [done, setDone] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!value || !dialog.current || dialog.current.open) return;
    setText("");
    setDone(true);
    setError("");
    setSaving(false);
    dialog.current.showModal();
    actionInput.current?.focus();
  }, [value]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value) return;
    setError("");
    setSaving(true);
    try {
      await save(value, text, done);
      dialog.current?.close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the action.");
      setSaving(false);
    }
  }

  return (
    <dialog className="action-dialog" onClose={close} ref={dialog}>
      {value && (
        <form onSubmit={submit}>
          <header className="dialog-heading">
            <div>
              <p className="eyebrow">{value.name}</p>
              <h2>Add an action</h2>
            </div>
            <button className="close-button" onClick={() => dialog.current?.close()} type="button" aria-label="Close">
              ×
            </button>
          </header>

          <label className="field">
            <span>Action</span>
            <input
              autoFocus
              maxLength={500}
              onChange={(event) => setText(event.target.value)}
              placeholder="What did you do, or what will you do?"
              ref={actionInput}
              required
              value={text}
            />
          </label>

          <label className="done-control">
            <input
              checked={done}
              onChange={(event) => setDone(event.target.checked)}
              role="switch"
              type="checkbox"
            />
            <span>
              <strong>Done</strong>
              <small>{done ? "This action is already done." : "Keep this action planned for today."}</small>
            </span>
          </label>

          {error && <p className="form-error" role="alert">{error}</p>}
          <footer className="dialog-actions">
            <button className="quiet-button" onClick={() => dialog.current?.close()} type="button">Cancel</button>
            <button className="primary-button" disabled={saving} type="submit">
              {saving ? "Adding…" : "Add action"}
            </button>
          </footer>
        </form>
      )}
    </dialog>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromPath);
  const [today, setToday] = useState<Today>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionValue, setActionValue] = useState<Value>();

  const loadToday = useCallback(async () => {
    setError("");
    try {
      setToday(await api<Today>("/api/today"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load Today.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadToday();
    const onPopState = () => setRoute(routeFromPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadToday]);

  function navigate(nextRoute: Route) {
    window.history.pushState({}, "", `/${nextRoute}`);
    setRoute(nextRoute);
    window.scrollTo({ top: 0 });
  }

  async function createValue(name: string, meaning: string) {
    await api("/api/values", {
      body: JSON.stringify({ name, meaning }),
      method: "POST",
    });
    await loadToday();
    navigate("today");
  }

  async function saveAction(value: Value, text: string, done: boolean) {
    await api(`/api/values/${value.id}/actions`, {
      body: JSON.stringify({ text, done }),
      method: "POST",
    });
    await loadToday();
  }

  return (
    <Shell date={today?.date} navigate={navigate} route={route}>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {route === "today" && (
        <TodayPage data={today} loading={loading} navigate={navigate} openAction={setActionValue} />
      )}
      {route === "values" && <ValuesPage createValue={createValue} data={today} />}
      {route !== "today" && route !== "values" && <PlaceholderPage route={route} />}
      <ActionDialog close={() => setActionValue(undefined)} save={saveAction} value={actionValue} />
    </Shell>
  );
}
