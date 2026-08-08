import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { historyRange, shiftDate, type HistoryPreset } from "./history-range";

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

type ManagedValue = {
  id: string;
  name: string;
  meaning: string | null;
  position: number;
  status: "active" | "paused";
};

type Value = Omit<ManagedValue, "status"> & {
  actions: Action[];
};

type MenuEntry = {
  id: string;
  text: string;
  position: number;
};

type GoalHorizon = "week" | "month" | "year" | "someday";

type Goal = {
  id: string;
  text: string;
  horizon: GoalHorizon;
  periodStart: string | null;
  position: number;
};

type GoalLists = Record<GoalHorizon, Goal[]>;

type GoalChange =
  | { action: "complete" | "restore" }
  | { action: "move"; horizon: GoalHorizon; periodStart?: string };

type GoalsData = {
  goals: GoalLists;
  upcoming: Goal[];
  needsReview: Goal[];
  completed: Goal[];
};

type Today = {
  date: string;
  timeZone: {
    appTimeZone: string | null;
    effectiveTimeZone: string;
    needsConfirmation: boolean;
  };
  goals: GoalLists;
  needsReviewCount: number;
  values: Value[];
};

type HistoryValue = {
  key: string;
  id: string | null;
  name: string;
  deleted: boolean;
};

type HistoryData = {
  start: string;
  end: string;
  counts: (HistoryValue & { count: number })[];
  actions: {
    id: string;
    date: string;
    text: string;
    values: HistoryValue[];
  }[];
};

type ActionTarget = {
  value: Value;
  action?: Action;
};

type ActionInput = {
  primaryValueId: string;
  text: string;
  done: boolean;
  extraValueIds: string[];
  saveForReuse: boolean;
};

type Route = "today" | "values" | "goals" | "history" | "settings";

const navigation: { route: Route; label: string }[] = [
  { route: "today", label: "Today" },
  { route: "values", label: "Values" },
  { route: "goals", label: "Goals" },
  { route: "history", label: "History" },
  { route: "settings", label: "Settings" },
];

const goalHorizons: { horizon: GoalHorizon; label: string }[] = [
  { horizon: "week", label: "Week" },
  { horizon: "month", label: "Month" },
  { horizon: "year", label: "Year" },
  { horizon: "someday", label: "Someday" },
];

const historyPresets = [
  { preset: 7, label: "7 days" },
  { preset: 30, label: "30 days" },
  { preset: "3months", label: "3 months" },
] as const;

function emptyGoalLists(): GoalLists {
  return { week: [], month: [], year: [], someday: [] };
}

function emptyGoalsData(): GoalsData {
  return {
    goals: emptyGoalLists(),
    upcoming: [],
    needsReview: [],
    completed: [],
  };
}

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

function shortDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function goalPeriodLabel(goal: Goal) {
  if (!goal.periodStart) return "Someday";
  if (goal.horizon === "year") return goal.periodStart.slice(0, 4);
  const date = new Date(`${goal.periodStart}T12:00:00.000Z`);
  if (goal.horizon === "month") {
    return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(date);
  }
  return `Week of ${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date)}`;
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
      ) : (
        <div className="today-layout">
          {!data?.values.length ? (
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
          <GoalDashboard
            goals={data?.goals ?? emptyGoalLists()}
            navigate={navigate}
            needsReviewCount={data?.needsReviewCount ?? 0}
          />
        </div>
      )}
    </main>
  );
}

function GoalDashboard({
  goals,
  needsReviewCount,
  navigate,
}: {
  goals: GoalLists;
  needsReviewCount: number;
  navigate: (route: Route) => void;
}) {
  return (
    <aside className="goal-dashboard" aria-labelledby="goals-in-view-title">
      <p className="eyebrow">Direction</p>
      <h2 id="goals-in-view-title">Goals in view</h2>
      <p>Keep these nearby while choosing.</p>
      {needsReviewCount > 0 && (
        <a
          className="goal-review-link"
          href="/goals"
          onClick={(event) => {
            event.preventDefault();
            navigate("goals");
          }}
        >
          {needsReviewCount} {needsReviewCount === 1 ? "Goal needs" : "Goals need"} review
        </a>
      )}
      <div className="goal-dashboard-lists">
        {goalHorizons.map(({ horizon, label }) => (
          <details key={horizon} open={horizon === "week"}>
            <summary>{label}</summary>
            {goals[horizon].length ? (
              <ul>
                {goals[horizon].map((goal) => <li key={goal.id}>{goal.text}</li>)}
              </ul>
            ) : (
              <p className="goal-empty">No current Goals.</p>
            )}
          </details>
        ))}
      </div>
    </aside>
  );
}

function ValuesPage({
  values,
  loading,
  createValue,
  updateValue,
  removeValue,
  moveValue,
}: {
  values: ManagedValue[];
  loading: boolean;
  createValue: (name: string, meaning: string) => Promise<void>;
  updateValue: (
    id: string,
    changes: { name?: string; meaning?: string; status?: "active" | "paused" },
  ) => Promise<void>;
  removeValue: (id: string) => Promise<void>;
  moveValue: (id: string, direction: -1 | 1) => Promise<void>;
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
      setName("");
      setMeaning("");
      setSaving(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the Value.");
      setSaving(false);
    }
  }

  return (
    <main className="page narrow-page">
      <header className="page-heading">
        <p className="eyebrow">Values</p>
        <h1>Your Values</h1>
        <p>Keep what fits now. You can change this list at any time.</p>
      </header>

      {loading ? (
        <p className="notice" aria-live="polite">Loading Values…</p>
      ) : (
        <ValueList
          moveValue={moveValue}
          removeValue={removeValue}
          updateValue={updateValue}
          values={values}
        />
      )}

      <section className="create-value" aria-labelledby="create-value-title">
        <h2 id="create-value-title">Add a Value</h2>
        <p>Choose a short name. Add what it means to you if that helps.</p>
        <form className="form-card" onSubmit={submit}>
          <label className="field">
            <span>Short name</span>
            <input
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
      </section>
    </main>
  );
}

function ValueList({
  values,
  updateValue,
  removeValue,
  moveValue,
}: {
  values: ManagedValue[];
  updateValue: (
    id: string,
    changes: { name?: string; meaning?: string; status?: "active" | "paused" },
  ) => Promise<void>;
  removeValue: (id: string) => Promise<void>;
  moveValue: (id: string, direction: -1 | 1) => Promise<void>;
}) {
  const active = values.filter((value) => value.status === "active");
  const paused = values.filter((value) => value.status === "paused");
  const editors = (items: ManagedValue[]) => (
    <ul className="value-list">
      {items.map((value, index) => (
        <ValueEditor
          canMoveDown={index < items.length - 1}
          canMoveUp={index > 0}
          key={value.id}
          moveValue={moveValue}
          removeValue={removeValue}
          updateValue={updateValue}
          value={value}
        />
      ))}
    </ul>
  );

  return (
    <section className="managed-values" aria-labelledby="active-values-title">
      <h2 id="active-values-title">Active Values</h2>
      {active.length ? editors(active) : <p className="notice">No Active Values.</p>}
      <details className="paused-values">
        <summary>Paused Values <span>{paused.length}</span></summary>
        {paused.length ? editors(paused) : <p className="notice">No Paused Values.</p>}
      </details>
    </section>
  );
}

function ValueEditor({
  value,
  canMoveUp,
  canMoveDown,
  updateValue,
  removeValue,
  moveValue,
}: {
  value: ManagedValue;
  canMoveUp: boolean;
  canMoveDown: boolean;
  updateValue: (
    id: string,
    changes: { name?: string; meaning?: string; status?: "active" | "paused" },
  ) => Promise<void>;
  removeValue: (id: string) => Promise<void>;
  moveValue: (id: string, direction: -1 | 1) => Promise<void>;
}) {
  const [name, setName] = useState(value.name);
  const [meaning, setMeaning] = useState(value.meaning ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    setName(value.name);
    setMeaning(value.meaning ?? "");
  }, [value.name, value.meaning]);

  async function run(change: () => Promise<void>) {
    setError("");
    setSaving(true);
    try {
      await change();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the Value.");
    } finally {
      setSaving(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await run(() => updateValue(value.id, { name, meaning }));
  }

  async function remove() {
    if (!window.confirm(`Delete ${value.name}? Its saved Action Menu will also be deleted.`)) return;
    await run(() => removeValue(value.id));
  }

  return (
    <li>
      <details
        className="managed-value"
        name="managed-value"
        onToggle={(event) => setOpened(event.currentTarget.open)}
      >
        <summary>
          <strong>{value.name}</strong>
          <span>{value.meaning || "No personal meaning yet."}</span>
        </summary>
        <p className="value-detail-state">
          State: <strong>{value.status === "active" ? "Active" : "Paused"}</strong>
        </p>
        <form onSubmit={submit}>
          <label className="field">
            <span>Short name</span>
            <input
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label className="field">
            <span>Personal meaning <small>Optional</small></span>
            <textarea
              maxLength={500}
              onChange={(event) => setMeaning(event.target.value)}
              rows={3}
              value={meaning}
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="value-controls">
            <span className="order-controls" aria-label={`Order ${value.name}`}>
              <button
                className="quiet-button"
                disabled={!canMoveUp || saving}
                onClick={() => void run(() => moveValue(value.id, -1))}
                type="button"
              >
                Move up
              </button>
              <button
                className="quiet-button"
                disabled={!canMoveDown || saving}
                onClick={() => void run(() => moveValue(value.id, 1))}
                type="button"
              >
                Move down
              </button>
            </span>
            <button className="primary-button" disabled={saving} type="submit">
              Save changes
            </button>
          </div>
          <div className="value-state-controls">
            <button
              className="quiet-button"
              disabled={saving}
              onClick={() => void run(() => updateValue(value.id, {
                status: value.status === "active" ? "paused" : "active",
              }))}
              type="button"
            >
              {value.status === "active" ? "Pause Value" : "Restore Value"}
            </button>
            <button className="danger-button" disabled={saving} onClick={() => void remove()} type="button">
              Delete Value
            </button>
          </div>
        </form>
        {opened && <ValueMenu value={value} />}
      </details>
    </li>
  );
}

function ValueMenu({ value }: { value: ManagedValue }) {
  const [entries, setEntries] = useState<MenuEntry[]>([]);
  const [newText, setNewText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setEntries(
      (await api<{ entries: MenuEntry[] }>(`/api/values/${value.id}/menu`)).entries,
    );
    setLoading(false);
  }, [value.id]);

  useEffect(() => {
    void load().catch((caught) => {
      setError(caught instanceof Error ? caught.message : "Could not load the Action Menu.");
      setLoading(false);
    });
  }, [load]);

  async function saveAndReload(change: () => Promise<void>) {
    setError("");
    setSaving(true);
    try {
      await change();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the Action Menu.");
    } finally {
      setSaving(false);
    }
  }

  async function addEntry(event: FormEvent) {
    event.preventDefault();
    await saveAndReload(async () => {
      await api(`/api/values/${value.id}/menu`, {
        body: JSON.stringify({ text: newText }),
        method: "POST",
      });
      setNewText("");
    });
  }

  async function moveEntry(id: string, direction: -1 | 1) {
    const ids = entries.map((entry) => entry.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await api(`/api/values/${value.id}/menu/order`, {
      body: JSON.stringify({ ids }),
      method: "PUT",
    });
  }

  return (
    <section className="value-menu" aria-labelledby={`menu-${value.id}`}>
      <h3 id={`menu-${value.id}`}>Action Menu</h3>
      <p>Save actions that may help again.</p>
      {loading ? (
        <p className="notice" aria-live="polite">Loading Action Menu…</p>
      ) : (
        <ul className="action-menu-list">
          {entries.map((entry, index) => (
            <MenuEntryEditor
              canMoveDown={index < entries.length - 1}
              canMoveUp={index > 0}
              entry={entry}
              key={entry.id}
              move={(direction) => saveAndReload(() => moveEntry(entry.id, direction))}
              remove={() => saveAndReload(async () => {
                await api(`/api/menu/${entry.id}`, { method: "DELETE" });
              })}
              saving={saving}
              update={(text) => saveAndReload(async () => {
                await api(`/api/menu/${entry.id}`, {
                  body: JSON.stringify({ text }),
                  method: "PATCH",
                });
              })}
            />
          ))}
        </ul>
      )}
      {!loading && entries.length === 0 && (
        <p className="notice">No saved actions yet.</p>
      )}
      <form className="add-menu-entry" onSubmit={addEntry}>
        <label className="field">
          <span>New menu entry</span>
          <input
            maxLength={500}
            onChange={(event) => setNewText(event.target.value)}
            placeholder={`An action for ${value.name}`}
            required
            value={newText}
          />
        </label>
        <button className="quiet-button" disabled={saving} type="submit">
          Add to menu
        </button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

function MenuEntryEditor({
  entry,
  canMoveUp,
  canMoveDown,
  saving,
  update,
  remove,
  move,
}: {
  entry: MenuEntry;
  canMoveUp: boolean;
  canMoveDown: boolean;
  saving: boolean;
  update: (text: string) => Promise<void>;
  remove: () => Promise<void>;
  move: (direction: -1 | 1) => Promise<void>;
}) {
  const [text, setText] = useState(entry.text);

  useEffect(() => setText(entry.text), [entry.text]);

  return (
    <li>
      <form className="menu-entry" onSubmit={(event) => {
        event.preventDefault();
        void update(text);
      }}>
        <input
          aria-label="Action Menu Entry"
          maxLength={500}
          onChange={(event) => setText(event.target.value)}
          required
          value={text}
        />
        <div className="menu-entry-controls">
          <button className="quiet-button" disabled={saving} type="submit">Save</button>
          <button className="quiet-button" disabled={!canMoveUp || saving} onClick={() => void move(-1)} type="button">Move up</button>
          <button className="quiet-button" disabled={!canMoveDown || saving} onClick={() => void move(1)} type="button">Move down</button>
          <button className="danger-button" disabled={saving} onClick={() => void remove()} type="button">Delete</button>
        </div>
      </form>
    </li>
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

function GoalsPage({
  data,
  loading,
  createGoal,
  moveGoal,
  changeGoal,
  removeGoal,
}: {
  data: GoalsData;
  loading: boolean;
  createGoal: (horizon: GoalHorizon, text: string, periodStart?: string) => Promise<void>;
  moveGoal: (horizon: GoalHorizon, id: string, direction: -1 | 1) => Promise<void>;
  changeGoal: (id: string, change: GoalChange) => Promise<void>;
  removeGoal: (goal: Goal) => Promise<void>;
}) {
  const [error, setError] = useState("");

  async function runGoalChange(change: () => Promise<void>) {
    setError("");
    try {
      await change();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update this Goal.");
    }
  }

  return (
    <main className="page goals-page">
      <header className="page-heading">
        <p className="eyebrow">Goals</p>
        <h1>Your Goals</h1>
        <p>Keep a few finishable outcomes nearby as friendly direction.</p>
      </header>
      {error && <p className="form-error" role="alert">{error}</p>}

      {loading ? (
        <p className="notice" aria-live="polite">Loading Goals…</p>
      ) : (
        <div className="goal-lists">
          {goalHorizons.map(({ horizon, label }) => (
            <GoalList
              createGoal={createGoal}
              goals={data.goals[horizon]}
              horizon={horizon}
              key={horizon}
              label={label}
              moveGoal={moveGoal}
              changeGoal={changeGoal}
              removeGoal={removeGoal}
            />
          ))}
        </div>
      )}

      {!loading && (
        <>
          <section className="goal-state-section" aria-labelledby="upcoming-goals-title">
            <header>
              <h2 id="upcoming-goals-title">Upcoming</h2>
              <span>{data.upcoming.length}</span>
            </header>
            {data.upcoming.length ? (
              <ul className="managed-goals">
                {data.upcoming.map((goal) => (
                  <li key={goal.id}>
                    <span className="goal-copy">
                      <strong>{goal.text}</strong>
                      <small>{goalPeriodLabel(goal)}</small>
                    </span>
                    <span className="goal-action-controls">
                      <button className="quiet-button" onClick={() => void runGoalChange(() => changeGoal(goal.id, { action: "complete" }))} type="button">Done</button>
                      <button className="danger-button" onClick={() => void runGoalChange(() => removeGoal(goal))} type="button">Delete</button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="goal-list-empty">No Upcoming Goals.</p>}
          </section>

          <section className="goal-state-section" aria-labelledby="review-goals-title">
            <header>
              <h2 id="review-goals-title">Needs Review</h2>
              <span>{data.needsReview.length}</span>
            </header>
            <p className="goal-section-help">Choose where each expired Goal goes next.</p>
            {data.needsReview.length ? (
              <ul className="review-goals">
                {data.needsReview.map((goal) => (
                  <NeedsReviewGoal
                    changeGoal={changeGoal}
                    goal={goal}
                    key={goal.id}
                    removeGoal={removeGoal}
                  />
                ))}
              </ul>
            ) : <p className="goal-list-empty">Nothing needs review.</p>}
          </section>

          <details className="completed-goals">
            <summary>Completed Goals <span>{data.completed.length}</span></summary>
            {data.completed.length ? (
              <ul className="managed-goals">
                {data.completed.map((goal) => (
                  <li key={goal.id}>
                    <span className="goal-copy">
                      <strong>{goal.text}</strong>
                      <small>{goalPeriodLabel(goal)}</small>
                    </span>
                    <span className="goal-action-controls">
                      <button className="quiet-button" onClick={() => void runGoalChange(() => changeGoal(goal.id, { action: "restore" }))} type="button">Restore</button>
                      <button className="danger-button" onClick={() => void runGoalChange(() => removeGoal(goal))} type="button">Delete</button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="goal-list-empty">No Completed Goals.</p>}
          </details>
        </>
      )}
    </main>
  );
}

function GoalList({
  horizon,
  label,
  goals,
  createGoal,
  moveGoal,
  changeGoal,
  removeGoal,
}: {
  horizon: GoalHorizon;
  label: string;
  goals: Goal[];
  createGoal: (horizon: GoalHorizon, text: string, periodStart?: string) => Promise<void>;
  moveGoal: (horizon: GoalHorizon, id: string, direction: -1 | 1) => Promise<void>;
  changeGoal: (id: string, change: GoalChange) => Promise<void>;
  removeGoal: (goal: Goal) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function changeGoalList(change: () => Promise<void>) {
    setError("");
    setSaving(true);
    try {
      await change();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the Goal List.");
    } finally {
      setSaving(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await changeGoalList(async () => {
      await createGoal(horizon, text, periodStart || undefined);
      setText("");
      setPeriodStart("");
    });
  }

  return (
    <section className="goal-list-section" aria-labelledby={`${horizon}-goals-title`}>
      <header>
        <h2 id={`${horizon}-goals-title`}>{label}</h2>
        <span>{goals.length}</span>
      </header>
      {goals.length ? (
        <ul className="managed-goals">
          {goals.map((goal, index) => (
            <li key={goal.id}>
              <strong>{goal.text}</strong>
              <span className="goal-action-controls">
                <span className="goal-order-controls" aria-label={`Order ${goal.text}`}>
                <button
                  aria-label={`Move ${goal.text} up`}
                  className="quiet-button"
                  disabled={index === 0 || saving}
                  onClick={() => void changeGoalList(() => moveGoal(horizon, goal.id, -1))}
                  type="button"
                >
                  ↑
                </button>
                <button
                  aria-label={`Move ${goal.text} down`}
                  className="quiet-button"
                  disabled={index === goals.length - 1 || saving}
                  onClick={() => void changeGoalList(() => moveGoal(horizon, goal.id, 1))}
                  type="button"
                >
                  ↓
                </button>
                </span>
                <button className="quiet-button" disabled={saving} onClick={() => void changeGoalList(() => changeGoal(goal.id, { action: "complete" }))} type="button">Done</button>
                <button className="danger-button" disabled={saving} onClick={() => void changeGoalList(() => removeGoal(goal))} type="button">Delete</button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="goal-list-empty">No Goals here yet.</p>
      )}
      <form className="quick-add-goal" onSubmit={submit}>
        <label className="field">
          <span>Add a {label} Goal</span>
          <input
            maxLength={200}
            onChange={(event) => setText(event.target.value)}
            placeholder="A finishable outcome"
            required
            value={text}
          />
        </label>
        {horizon !== "someday" && (
          <label className="field">
            <span>Date in that {label} <small>Optional</small></span>
            <input
              onChange={(event) => setPeriodStart(event.target.value)}
              type="date"
              value={periodStart}
            />
          </label>
        )}
        <button className="primary-button" disabled={saving} type="submit">
          {saving ? "Adding…" : "Add Goal"}
        </button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

function NeedsReviewGoal({
  goal,
  changeGoal,
  removeGoal,
}: {
  goal: Goal;
  changeGoal: (id: string, change: GoalChange) => Promise<void>;
  removeGoal: (goal: Goal) => Promise<void>;
}) {
  const [horizon, setHorizon] = useState<GoalHorizon>(goal.horizon);
  const [periodStart, setPeriodStart] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function runGoalChange(change: () => Promise<void>) {
    setError("");
    setSaving(true);
    try {
      await change();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update this Goal.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li>
      <div className="review-goal-heading">
        <strong>{goal.text}</strong>
        <small>Former period: {goalPeriodLabel(goal)}</small>
      </div>
      <div className="review-goal-choice">
        <label className="field">
          <span>Move to</span>
          <select onChange={(event) => setHorizon(event.target.value as GoalHorizon)} value={horizon}>
            {goalHorizons.map((item) => <option key={item.horizon} value={item.horizon}>{item.label}</option>)}
          </select>
        </label>
        {horizon !== "someday" && (
          <label className="field">
            <span>Date <small>Optional. Blank means current.</small></span>
            <input onChange={(event) => setPeriodStart(event.target.value)} type="date" value={periodStart} />
          </label>
        )}
        <button
          className="primary-button"
          disabled={saving}
          onClick={() => void runGoalChange(() => changeGoal(goal.id, {
            action: "move",
            horizon,
            periodStart: horizon === "someday" || !periodStart ? undefined : periodStart,
          }))}
          type="button"
        >
          Move Goal
        </button>
      </div>
      <div className="review-goal-actions">
        <button className="quiet-button" disabled={saving} onClick={() => void runGoalChange(() => changeGoal(goal.id, { action: "complete" }))} type="button">Done</button>
        <button className="danger-button" disabled={saving} onClick={() => void runGoalChange(() => removeGoal(goal))} type="button">Delete</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </li>
  );
}

function HistoryPage({ today }: { today?: string }) {
  const [preset, setPreset] = useState<HistoryPreset | "custom">(30);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [selectedValue, setSelectedValue] = useState<string>();
  const [data, setData] = useState<HistoryData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const historyRequest = useRef(0);

  const loadHistory = useCallback(async (
    nextStart: string,
    nextEnd: string,
    value?: string,
  ) => {
    const request = ++historyRequest.current;
    setError("");
    setLoading(true);
    try {
      const query = new URLSearchParams({ start: nextStart, end: nextEnd });
      if (value) query.set("value", value);
      const nextData = await api<HistoryData>(`/api/history?${query}`);
      if (request === historyRequest.current) setData(nextData);
    } catch (caught) {
      if (request === historyRequest.current) {
        setError(caught instanceof Error ? caught.message : "Could not load History.");
      }
    } finally {
      if (request === historyRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!today) return;
    const range = historyRange(today, 30);
    setStart(range.start);
    setEnd(range.end);
    void loadHistory(range.start, range.end);
  }, [loadHistory, today]);

  function choosePreset(nextPreset: HistoryPreset) {
    if (!today) return;
    const range = historyRange(today, nextPreset);
    setPreset(nextPreset);
    setStart(range.start);
    setEnd(range.end);
    setSelectedValue(undefined);
    void loadHistory(range.start, range.end);
  }

  function applyCustomRange(event: FormEvent) {
    event.preventDefault();
    const lastPastDate = today ? shiftDate(today, -1) : "";
    if (!start || !end || start > end || end > lastPastDate) {
      setError("Choose a past range, from the first date to the last.");
      return;
    }
    setSelectedValue(undefined);
    void loadHistory(start, end);
  }

  function filterBy(value?: string) {
    setSelectedValue(value);
    void loadHistory(start, end, value);
  }

  return (
    <main className="page history-page">
      <header className="history-page-heading">
        <div className="page-heading">
          <p className="eyebrow">History</p>
          <h1>Done actions</h1>
          <p>Only past actions marked Done.</p>
        </div>
        <span className="read-only-label">Read only</span>
      </header>

      <section className="history-range" aria-label="History date range">
        <div className="history-presets" role="group" aria-label="Date range presets">
          {historyPresets.map((item) => (
            <button
              aria-pressed={preset === item.preset}
              className="history-preset"
              disabled={!today}
              key={item.preset}
              onClick={() => choosePreset(item.preset)}
              type="button"
            >
              {item.label}
            </button>
          ))}
          <button
            aria-pressed={preset === "custom"}
            className="history-preset"
            disabled={!today}
            onClick={() => setPreset("custom")}
            type="button"
          >
            Custom
          </button>
        </div>
        {preset === "custom" && (
          <form className="custom-history-range" onSubmit={applyCustomRange}>
            <label className="field">
              <span>From</span>
              <input
                max={today ? shiftDate(today, -1) : undefined}
                onChange={(event) => setStart(event.target.value)}
                required
                type="date"
                value={start}
              />
            </label>
            <label className="field">
              <span>To</span>
              <input
                max={today ? shiftDate(today, -1) : undefined}
                onChange={(event) => setEnd(event.target.value)}
                required
                type="date"
                value={end}
              />
            </label>
            <button className="quiet-button" type="submit">Show range</button>
          </form>
        )}
      </section>

      {error && <p className="form-error history-error" role="alert">{error}</p>}
      {loading ? (
        <p className="notice" aria-live="polite">Loading History…</p>
      ) : !data?.actions.length && !data?.counts.length ? (
        <p className="history-empty">No Done actions in this period.</p>
      ) : data ? (
        <section aria-labelledby="history-actions-title">
          <header className="history-summary">
            <div>
              <h2 id="history-actions-title">Done actions</h2>
              <p>{shortDate(data.start)} to {shortDate(data.end)}</p>
            </div>
            <span>{data.actions.length} shown</span>
          </header>
          <div className="history-value-filters" aria-label="Filter by Value" role="group">
            <button
              aria-pressed={!selectedValue}
              className="history-value-filter"
              onClick={() => filterBy()}
              type="button"
            >
              All
            </button>
            {data.counts.map((count) => (
              <button
                aria-pressed={selectedValue === count.key}
                className="history-value-filter"
                key={count.key}
                onClick={() => filterBy(count.key)}
                type="button"
              >
                <span>
                  {count.name}
                  {count.deleted && <small>Deleted Value</small>}
                </span>
                <strong aria-label={`${count.count} Done actions`}>{count.count}</strong>
              </button>
            ))}
          </div>
          {data.actions.length ? (
            <div className="history-stream">
              {data.actions.map((action) => (
                <article className="history-row" key={action.id}>
                  <div className="history-row-values">
                    {action.values.map((value) => (
                      <span key={value.key}>
                        {value.name}
                        {value.deleted && <small>Deleted Value</small>}
                      </span>
                    ))}
                  </div>
                  <p>{action.text}</p>
                  <time dateTime={action.date}>{shortDate(action.date)}</time>
                </article>
              ))}
            </div>
          ) : (
            <p className="history-empty">No Done actions for this Value.</p>
          )}
          <p className="history-note">Counts show how many Done actions included each Value.</p>
        </section>
      ) : null}
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
    input: ActionInput,
  ) => Promise<void>;
  remove: (actionId: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const actionInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [done, setDone] = useState(true);
  const [primaryValueId, setPrimaryValueId] = useState("");
  const [extraValueIds, setExtraValueIds] = useState<string[]>([]);
  const [menuEntries, setMenuEntries] = useState<MenuEntry[]>([]);
  const [menuFilter, setMenuFilter] = useState("");
  const [menuLoading, setMenuLoading] = useState(false);
  const [selectedMenuEntryId, setSelectedMenuEntryId] = useState<string>();
  const [saveForReuse, setSaveForReuse] = useState(false);
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
    setMenuEntries([]);
    setMenuFilter("");
    setMenuLoading(false);
    setSelectedMenuEntryId(undefined);
    setSaveForReuse(false);
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
      await save(
        target.action,
        { primaryValueId, text, done, extraValueIds, saveForReuse },
      );
      dialog.current?.close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the action.");
      setSaving(false);
    }
  }

  async function openMenu() {
    if (!target) return;
    setError("");
    setMenuLoading(true);
    try {
      setMenuEntries(
        (await api<{ entries: MenuEntry[] }>(
          `/api/values/${target.value.id}/menu`,
        )).entries,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the Action Menu.");
    } finally {
      setMenuLoading(false);
    }
  }

  const filteredMenuEntries = menuEntries.filter((entry) =>
    entry.text.toLocaleLowerCase().includes(menuFilter.trim().toLocaleLowerCase()),
  );

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
        <form key={target.action?.id ?? target.value.id} onSubmit={submit}>
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
              onChange={(event) => {
                setText(event.target.value);
                setSelectedMenuEntryId(undefined);
              }}
              placeholder="What did you do, or what will you do?"
              ref={actionInput}
              required
              value={text}
            />
          </label>

          {!target.action && (
            <details
              className="action-menu-picker"
              onToggle={(event) => {
                if (event.currentTarget.open) void openMenu();
              }}
            >
              <summary>Open the menu</summary>
              <div className="menu-picker-body">
                <input
                  aria-label="Type to filter"
                  onChange={(event) => setMenuFilter(event.target.value)}
                  placeholder="Type to filter"
                  type="search"
                  value={menuFilter}
                />
                {menuLoading ? (
                  <p className="notice" aria-live="polite">Loading menu…</p>
                ) : filteredMenuEntries.length ? (
                  <div className="menu-picker-results">
                    {filteredMenuEntries.map((entry) => (
                      <button
                        key={entry.id}
                        onClick={() => {
                          setText(entry.text);
                          setSelectedMenuEntryId(entry.id);
                          setSaveForReuse(false);
                          actionInput.current?.focus();
                        }}
                        type="button"
                      >
                        {entry.text}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="notice">No matching action.</p>
                )}
              </div>
            </details>
          )}

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

          {!target.action && !selectedMenuEntryId && (
            <label className="reuse-control">
              <input
                checked={saveForReuse}
                onChange={(event) => setSaveForReuse(event.target.checked)}
                type="checkbox"
              />
              <span>
                <strong>Save for reuse</strong>
                <small>
                  {extraValueIds.length
                    ? "Adds a separate copy to each selected Value."
                    : `Adds this free entry to ${target.value.name}’s Action Menu.`}
                </small>
              </span>
            </label>
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
  const [values, setValues] = useState<ManagedValue[]>([]);
  const [valuesLoading, setValuesLoading] = useState(true);
  const [goalData, setGoalData] = useState<GoalsData>(emptyGoalsData);
  const [goalsLoading, setGoalsLoading] = useState(true);
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

  const loadValues = useCallback(async () => {
    setError("");
    try {
      setValues((await api<{ values: ManagedValue[] }>("/api/values")).values);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load Values.");
    } finally {
      setValuesLoading(false);
    }
  }, []);

  const loadGoals = useCallback(async () => {
    setError("");
    try {
      setGoalData(await api<GoalsData>("/api/goals"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load Goals.");
    } finally {
      setGoalsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadToday();
    const onPopState = () => setRoute(routeFromPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadToday]);

  useEffect(() => {
    if (route === "values") void loadValues();
    if (route === "goals") void loadGoals();
  }, [loadGoals, loadValues, route]);

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
    await Promise.all([loadToday(), loadValues()]);
  }

  async function updateValue(
    id: string,
    changes: { name?: string; meaning?: string; status?: "active" | "paused" },
  ) {
    await api(`/api/values/${id}`, {
      body: JSON.stringify(changes),
      method: "PATCH",
    });
    await Promise.all([loadToday(), loadValues()]);
  }

  async function removeValue(id: string) {
    await api(`/api/values/${id}`, { method: "DELETE" });
    await Promise.all([loadToday(), loadValues()]);
  }

  async function moveValue(id: string, direction: -1 | 1) {
    const value = values.find((item) => item.id === id);
    if (!value) return;
    const peers = values.filter((item) => item.status === value.status);
    const peerIndex = peers.findIndex((item) => item.id === id);
    const target = peers[peerIndex + direction];
    if (!target) return;

    const ids = values.map((item) => item.id);
    const currentIndex = ids.indexOf(id);
    const targetIndex = ids.indexOf(target.id);
    [ids[currentIndex], ids[targetIndex]] = [ids[targetIndex], ids[currentIndex]];
    await api("/api/values/order", {
      body: JSON.stringify({ ids }),
      method: "PUT",
    });
    await Promise.all([loadToday(), loadValues()]);
  }

  async function saveAction(
    action: Action | undefined,
    input: ActionInput,
  ) {
    await api(action ? `/api/actions/${action.id}` : `/api/values/${input.primaryValueId}/actions`, {
      body: JSON.stringify(input),
      method: action ? "PATCH" : "POST",
    });
    await loadToday();
  }

  async function removeAction(actionId: string) {
    await api(`/api/actions/${actionId}`, { method: "DELETE" });
    await loadToday();
  }

  async function createGoal(horizon: GoalHorizon, text: string, periodStart?: string) {
    await api("/api/goals", {
      body: JSON.stringify({ horizon, text, periodStart }),
      method: "POST",
    });
    await Promise.all([loadGoals(), loadToday()]);
  }

  async function moveGoal(
    horizon: GoalHorizon,
    id: string,
    direction: -1 | 1,
  ) {
    const ids = goalData.goals[horizon].map((goal) => goal.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await api("/api/goals/order", {
      body: JSON.stringify({ horizon, ids }),
      method: "PUT",
    });
    await Promise.all([loadGoals(), loadToday()]);
  }

  async function changeGoal(id: string, change: GoalChange) {
    await api(`/api/goals/${id}`, {
      body: JSON.stringify(change),
      method: "PATCH",
    });
    await Promise.all([loadGoals(), loadToday()]);
  }

  async function removeGoal(goal: Goal) {
    if (!window.confirm(`Delete “${goal.text}”?`)) return;
    await api(`/api/goals/${goal.id}`, { method: "DELETE" });
    await Promise.all([loadGoals(), loadToday()]);
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
      {route === "values" && (
        <ValuesPage
          createValue={createValue}
          loading={valuesLoading}
          moveValue={moveValue}
          removeValue={removeValue}
          updateValue={updateValue}
          values={values}
        />
      )}
      {route === "goals" && (
        <GoalsPage
          changeGoal={changeGoal}
          createGoal={createGoal}
          data={goalData}
          loading={goalsLoading}
          moveGoal={moveGoal}
          removeGoal={removeGoal}
        />
      )}
      {route === "settings" && <SettingsPage data={today} saveTimeZone={saveTimeZone} />}
      {route === "history" && <HistoryPage today={today?.date} />}
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
