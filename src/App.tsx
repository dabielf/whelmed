import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

type Action = {
  id: string;
  text: string;
  status: "planned" | "done";
  created_at: string;
  values: {
    id: string;
    name: string;
    isPrimary: boolean;
  }[];
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
  timeZone: {
    appTimeZone: string | null;
    effectiveTimeZone: string;
    needsConfirmation: boolean;
  };
  values: Value[];
};

type ActionTarget = {
  value: Value;
  action?: Action;
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
const timeZones = Intl.supportedValuesOf("timeZone");

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
  const body = (response.status === 204
    ? {}
    : await response.json()) as T & { error?: string };
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

function actionSummary(actions: Action[]) {
  if (!actions.length) return "No action yet.";
  const hasDone = actions.some((action) => action.status === "done");
  const hasPlanned = actions.some((action) => action.status === "planned");
  if (hasDone && hasPlanned) return "Done and Planned actions are here.";
  return hasDone ? "A Done action is here." : "An action is planned.";
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
  openAction: (value: Value, action?: Action) => void;
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
                  <p>{actionSummary(value.actions)}</p>
                </div>
                <button className="quiet-button" onClick={() => openAction(value)}>
                  Add action
                </button>
              </header>

              {value.actions.length > 0 && (
                <ul className="action-list">
                  {value.actions.map((action) => (
                    <li className="action-row" key={action.id}>
                      <button
                        className="action-button"
                        onClick={() => openAction(value, action)}
                        type="button"
                      >
                        <span className={`state-mark ${action.status}`} aria-hidden="true">
                          {action.status === "done" ? "✓" : "○"}
                        </span>
                        <span className="action-copy">
                          <span>{action.text}</span>
                          {action.values.some((linkedValue) => !linkedValue.isPrimary) && (
                            <small>
                              Also: {action.values
                                .filter((linkedValue) => !linkedValue.isPrimary)
                                .map((linkedValue) => linkedValue.name)
                                .join(", ")}
                            </small>
                          )}
                        </span>
                        <span className="state-label">
                          {action.status === "done" ? "Done" : "Planned"}
                        </span>
                      </button>
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

function SettingsPage({
  data,
  saveTimeZone,
}: {
  data?: Today;
  saveTimeZone: (timeZone: string) => Promise<void>;
}) {
  const currentTimeZone =
    data?.timeZone.appTimeZone ??
    data?.timeZone.effectiveTimeZone ??
    browserTimeZone;
  const [timeZone, setTimeZone] = useState(currentTimeZone);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => setTimeZone(currentTimeZone), [currentTimeZone]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      await saveTimeZone(timeZone);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the Time Zone.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="page narrow-page">
      <header className="page-heading">
        <p className="eyebrow">Settings</p>
        <h1>App Time Zone</h1>
        <p>This decides when Today ends on every device.</p>
      </header>

      <form className="form-card" onSubmit={submit}>
        {!data ? (
          <p className="notice" aria-live="polite">Loading Settings…</p>
        ) : data.timeZone.needsConfirmation ? (
          <p className="settings-reminder" role="status">
            No App Time Zone is saved yet. This browser is using <strong>{data.timeZone.effectiveTimeZone}</strong>.
          </p>
        ) : (
          <p className="notice">
            Saved App Time Zone: <strong>{data.timeZone.appTimeZone}</strong>
          </p>
        )}
        <label className="field">
          <span>Time Zone</span>
          <select onChange={(event) => {
            setTimeZone(event.target.value);
            setSaved(false);
          }} value={timeZone}>
            {!timeZones.includes(timeZone) && <option value={timeZone}>{timeZone}</option>}
            {timeZones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        {saved && <p className="form-success" role="status">Time Zone saved.</p>}
        <button className="primary-button" disabled={saving} type="submit">
          {saving ? "Saving…" : "Save Time Zone"}
        </button>
      </form>
    </main>
  );
}

function PlaceholderPage({ route }: { route: Exclude<Route, "today" | "values" | "settings"> }) {
  const text = {
    goals: ["Goals", "Friendly finish lines will live here."],
    history: ["History", "Past Done actions will live here."],
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
  target,
  values,
  close,
  save,
  remove,
}: {
  target?: ActionTarget;
  values: Value[];
  close: () => void;
  save: (
    action: Action | undefined,
    primaryValueId: string,
    text: string,
    done: boolean,
    extraValueIds: string[],
  ) => Promise<void>;
  remove: (actionId: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const actionInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [done, setDone] = useState(true);
  const [primaryValueId, setPrimaryValueId] = useState("");
  const [extraValueIds, setExtraValueIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!target || !dialog.current || dialog.current.open) return;
    const primaryValue = target.action?.values.find(
      (linkedValue) => linkedValue.isPrimary,
    );
    setText(target.action?.text ?? "");
    setDone(target.action?.status !== "planned");
    setPrimaryValueId(primaryValue?.id ?? target.value.id);
    setExtraValueIds(
      target.action?.values
        .filter((linkedValue) => !linkedValue.isPrimary)
        .map((linkedValue) => linkedValue.id) ?? [],
    );
    setError("");
    setSaving(false);
    dialog.current.showModal();
    actionInput.current?.focus();
  }, [target]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    setError("");
    setSaving(true);
    try {
      await save(target.action, primaryValueId, text, done, extraValueIds);
      dialog.current?.close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the action.");
      setSaving(false);
    }
  }

  async function deleteAction() {
    if (!target?.action || !window.confirm("Delete this action?")) return;
    setError("");
    setSaving(true);
    try {
      await remove(target.action.id);
      dialog.current?.close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the action.");
      setSaving(false);
    }
  }

  return (
    <dialog className="action-dialog" onClose={close} ref={dialog}>
      {target && (
        <form onSubmit={submit}>
          <header className="dialog-heading">
            <div>
              <p className="eyebrow">{target.action ? "Today" : target.value.name}</p>
              <h2>{target.action ? "Edit action" : "Add an action"}</h2>
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

          {target.action && values.length > 1 && (
            <label className="field">
              <span>Primary Value</span>
              <select
                onChange={(event) => {
                  setPrimaryValueId(event.target.value);
                  setExtraValueIds((current) =>
                    current.filter((valueId) => valueId !== event.target.value),
                  );
                }}
                value={primaryValueId}
              >
                {values.map((value) => (
                  <option key={value.id} value={value.id}>{value.name}</option>
                ))}
              </select>
            </label>
          )}

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

          {values.length > 1 && (
            <details className="extra-values">
              <summary>Add another Value</summary>
              <fieldset>
                <legend>This action also fits</legend>
                {values
                  .filter((value) => value.id !== primaryValueId)
                  .map((value) => (
                    <label key={value.id}>
                      <input
                        checked={extraValueIds.includes(value.id)}
                        onChange={(event) =>
                          setExtraValueIds((current) =>
                            event.target.checked
                              ? [...current, value.id]
                              : current.filter((valueId) => valueId !== value.id),
                          )
                        }
                        type="checkbox"
                      />
                      <span>{value.name}</span>
                    </label>
                  ))}
              </fieldset>
            </details>
          )}

          {error && <p className="form-error" role="alert">{error}</p>}
          <footer className="dialog-actions">
            {target.action && (
              <button className="danger-button" disabled={saving} onClick={deleteAction} type="button">
                Delete action
              </button>
            )}
            <span className="dialog-save-actions">
              <button className="quiet-button" onClick={() => dialog.current?.close()} type="button">Cancel</button>
              <button className="primary-button" disabled={saving} type="submit">
                {saving ? "Saving…" : target.action ? "Save changes" : "Add action"}
              </button>
            </span>
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
  const [actionTarget, setActionTarget] = useState<ActionTarget>();

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

  async function saveAction(
    action: Action | undefined,
    primaryValueId: string,
    text: string,
    done: boolean,
    extraValueIds: string[],
  ) {
    await api(action ? `/api/actions/${action.id}` : `/api/values/${primaryValueId}/actions`, {
      body: JSON.stringify({ text, done, primaryValueId, extraValueIds }),
      method: action ? "PATCH" : "POST",
    });
    await loadToday();
  }

  async function removeAction(actionId: string) {
    await api(`/api/actions/${actionId}`, { method: "DELETE" });
    await loadToday();
  }

  async function saveTimeZone(appTimeZone: string) {
    await api("/api/settings", {
      body: JSON.stringify({ appTimeZone }),
      method: "PATCH",
    });
    await loadToday();
  }

  return (
    <Shell date={today?.date} navigate={navigate} route={route}>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {route === "today" && (
        <TodayPage
          data={today}
          loading={loading}
          navigate={navigate}
          openAction={(value, action) => setActionTarget({ value, action })}
        />
      )}
      {route === "values" && <ValuesPage createValue={createValue} data={today} />}
      {route === "settings" && <SettingsPage data={today} saveTimeZone={saveTimeZone} />}
      {route !== "today" && route !== "values" && route !== "settings" && <PlaceholderPage route={route} />}
      <ActionDialog
        close={() => setActionTarget(undefined)}
        remove={removeAction}
        save={saveAction}
        target={actionTarget}
        values={today?.values ?? []}
      />
    </Shell>
  );
}
