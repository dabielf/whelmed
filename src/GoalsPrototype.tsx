// PROTOTYPE — Three Goals page variants, switchable via ?variant=, on the existing /goals route.
import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useState,
} from "react";
import "./goals-prototype.css";

type Horizon = "week" | "month" | "year" | "someday";

type PrototypeGoal = {
  id: string;
  text: string;
  horizon: Horizon;
  periodStart: string | null;
  position: number;
};

type GoalLists = Record<Horizon, PrototypeGoal[]>;

type PrototypeState = {
  goals: GoalLists;
  upcoming: PrototypeGoal[];
  needsReview: PrototypeGoal[];
  completed: PrototypeGoal[];
};

type PrototypeData = PrototypeState;
type Variant = "A" | "B" | "C";

type Editor = {
  goal?: PrototypeGoal;
  horizon: Horizon;
};

type VariantProps = {
  editor: Editor | null;
  onCloseEditor: () => void;
  onComplete: (goal: PrototypeGoal) => void;
  onDelete: (goal: PrototypeGoal) => void;
  onDrop: (horizon: Horizon, draggedId: string, targetId: string) => void;
  onEdit: (goal: PrototypeGoal) => void;
  onMove: (horizon: Horizon, id: string, direction: -1 | 1) => void;
  onNew: (horizon?: Horizon) => void;
  onRestore: (goal: PrototypeGoal) => void;
  onSave: (draft: Omit<PrototypeGoal, "id" | "position">) => void;
  reviewOpen: boolean;
  setReviewOpen: (open: boolean) => void;
  state: PrototypeState;
};

const horizons: { key: Horizon; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "someday", label: "Someday" },
];

const variantNames: Record<Variant, string> = {
  A: "Overview",
  B: "One list at a time",
  C: "Compact sections",
};

const sampleState: PrototypeState = {
  goals: {
    week: [
      { id: "week-1", text: "Send the draft", horizon: "week", periodStart: "2026-08-10", position: 0 },
      { id: "week-2", text: "Book the appointment", horizon: "week", periodStart: "2026-08-10", position: 1 },
      { id: "week-3", text: "Plan one quiet evening", horizon: "week", periodStart: "2026-08-10", position: 2 },
    ],
    month: [
      { id: "month-1", text: "Finish the reading corner", horizon: "month", periodStart: "2026-08-01", position: 0 },
      { id: "month-2", text: "Choose a weekend away", horizon: "month", periodStart: "2026-08-01", position: 1 },
    ],
    year: [
      { id: "year-1", text: "Complete the course", horizon: "year", periodStart: "2026-01-01", position: 0 },
    ],
    someday: [
      { id: "someday-1", text: "Learn bookbinding", horizon: "someday", periodStart: null, position: 0 },
      { id: "someday-2", text: "Take a long train trip", horizon: "someday", periodStart: null, position: 1 },
    ],
  },
  upcoming: [
    { id: "upcoming-1", text: "Renew the passport", horizon: "month", periodStart: "2026-09-01", position: 0 },
  ],
  needsReview: [
    { id: "review-1", text: "Choose a better desk chair", horizon: "month", periodStart: "2026-07-01", position: 0 },
  ],
  completed: [
    { id: "completed-1", text: "Clear the spare cupboard", horizon: "week", periodStart: "2026-08-03", position: 0 },
  ],
};

function copyState(state: PrototypeState): PrototypeState {
  return {
    goals: {
      week: [...state.goals.week],
      month: [...state.goals.month],
      year: [...state.goals.year],
      someday: [...state.goals.someday],
    },
    upcoming: [...state.upcoming],
    needsReview: [...state.needsReview],
    completed: [...state.completed],
  };
}

function initialState(data: PrototypeData): PrototypeState {
  const hasGoals = horizons.some(({ key }) => data.goals[key].length)
    || data.upcoming.length
    || data.needsReview.length
    || data.completed.length;
  return copyState(hasGoals ? data : sampleState);
}

function withoutGoal(state: PrototypeState, id: string): PrototypeState {
  return {
    goals: {
      week: state.goals.week.filter((goal) => goal.id !== id),
      month: state.goals.month.filter((goal) => goal.id !== id),
      year: state.goals.year.filter((goal) => goal.id !== id),
      someday: state.goals.someday.filter((goal) => goal.id !== id),
    },
    upcoming: state.upcoming.filter((goal) => goal.id !== id),
    needsReview: state.needsReview.filter((goal) => goal.id !== id),
    completed: state.completed.filter((goal) => goal.id !== id),
  };
}

function variantFromUrl(): Variant {
  const value = new URLSearchParams(window.location.search).get("variant");
  return value === "B" || value === "C" ? value : "A";
}

export function GoalsPrototype({ data, loading }: { data: PrototypeData; loading: boolean }) {
  const [state, setState] = useState<PrototypeState | null>(null);
  const [variant, setVariant] = useState<Variant>(variantFromUrl);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    if (!loading && !state) setState(initialState(data));
  }, [data, loading, state]);

  function selectVariant(next: Variant) {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState({}, "", url);
    setVariant(next);
    setEditor(null);
  }

  if (loading || !state) {
    return <main className="page"><p className="notice">Loading prototype…</p></main>;
  }

  function saveGoal(draft: Omit<PrototypeGoal, "id" | "position">) {
    setState((current) => {
      if (!current) return current;
      const id = editor?.goal?.id ?? `prototype-${Date.now()}`;
      const next = editor?.goal ? withoutGoal(current, id) : current;
      const goal: PrototypeGoal = {
        ...draft,
        id,
        position: next.goals[draft.horizon].length,
      };
      return {
        ...next,
        goals: {
          ...next.goals,
          [draft.horizon]: [...next.goals[draft.horizon], goal],
        },
      };
    });
    setEditor(null);
  }

  function completeGoal(goal: PrototypeGoal) {
    setState((current) => current && {
      ...withoutGoal(current, goal.id),
      completed: [...withoutGoal(current, goal.id).completed, goal],
    });
  }

  function deleteGoal(goal: PrototypeGoal) {
    if (!window.confirm(`Delete “${goal.text}”?`)) return;
    setState((current) => current && withoutGoal(current, goal.id));
  }

  function restoreGoal(goal: PrototypeGoal) {
    setState((current) => {
      if (!current) return current;
      const next = withoutGoal(current, goal.id);
      return {
        ...next,
        goals: {
          ...next.goals,
          [goal.horizon]: [...next.goals[goal.horizon], goal],
        },
      };
    });
  }

  function moveGoal(horizon: Horizon, id: string, direction: -1 | 1) {
    setState((current) => {
      if (!current) return current;
      const list = [...current.goals[horizon]];
      const index = list.findIndex((goal) => goal.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= list.length) return current;
      [list[index], list[target]] = [list[target], list[index]];
      return { ...current, goals: { ...current.goals, [horizon]: list } };
    });
  }

  function dropGoal(horizon: Horizon, draggedId: string, targetId: string) {
    setState((current) => {
      if (!current || draggedId === targetId) return current;
      const list = [...current.goals[horizon]];
      const from = list.findIndex((goal) => goal.id === draggedId);
      const to = list.findIndex((goal) => goal.id === targetId);
      if (from < 0 || to < 0) return current;
      const [dragged] = list.splice(from, 1);
      list.splice(to, 0, dragged);
      return { ...current, goals: { ...current.goals, [horizon]: list } };
    });
  }

  const props: VariantProps = {
    editor,
    onCloseEditor: () => setEditor(null),
    onComplete: completeGoal,
    onDelete: deleteGoal,
    onDrop: dropGoal,
    onEdit: (goal) => setEditor({ goal, horizon: goal.horizon }),
    onMove: moveGoal,
    onNew: (horizon = "week") => setEditor({ horizon }),
    onRestore: restoreGoal,
    onSave: saveGoal,
    reviewOpen,
    setReviewOpen,
    state,
  };

  return (
    <>
      {variant === "A" && <VariantA {...props} />}
      {variant === "B" && <VariantB {...props} />}
      {variant === "C" && <VariantC {...props} />}
      <PrototypeSwitcher current={variant} onChange={selectVariant} />
    </>
  );
}

function PrototypeHeader({ onAdd, quiet = false }: { onAdd: () => void; quiet?: boolean }) {
  return (
    <header className={`gproto-header ${quiet ? "is-quiet" : ""}`}>
      <div>
        <p className="eyebrow">Goals · Prototype</p>
        <h1>Your Goals</h1>
        <p>Finishable outcomes, kept close without taking over.</p>
      </div>
      <button className="primary-button" onClick={onAdd} type="button">Add Goal</button>
    </header>
  );
}

function ReviewNotice({
  goals,
  open,
  onComplete,
  onDelete,
  onEdit,
  setOpen,
}: {
  goals: PrototypeGoal[];
  open: boolean;
  onComplete: (goal: PrototypeGoal) => void;
  onDelete: (goal: PrototypeGoal) => void;
  onEdit: (goal: PrototypeGoal) => void;
  setOpen: (open: boolean) => void;
}) {
  if (!goals.length) return null;
  return (
    <section className="gproto-review" aria-labelledby="prototype-review-title">
      <button aria-expanded={open} onClick={() => setOpen(!open)} type="button">
        <span aria-hidden="true">↻</span>
        <span id="prototype-review-title">
          {goals.length} {goals.length === 1 ? "Goal needs" : "Goals need"} review
          <small>Choose what happens next.</small>
        </span>
        <strong>{open ? "Close" : "Review"}</strong>
      </button>
      {open && (
        <ul className="gproto-review-list">
          {goals.map((goal) => (
            <li key={goal.id}>
              <span><strong>{goal.text}</strong><small>From {periodLabel(goal)}</small></span>
              <GoalCommands goal={goal} onComplete={onComplete} onDelete={onDelete} onEdit={onEdit} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GoalList({
  goals,
  horizon,
  onComplete,
  onDelete,
  onDrop,
  onEdit,
  onMove,
}: {
  goals: PrototypeGoal[];
  horizon: Horizon;
  onComplete: (goal: PrototypeGoal) => void;
  onDelete: (goal: PrototypeGoal) => void;
  onDrop: (horizon: Horizon, draggedId: string, targetId: string) => void;
  onEdit: (goal: PrototypeGoal) => void;
  onMove: (horizon: Horizon, id: string, direction: -1 | 1) => void;
}) {
  if (!goals.length) return <p className="gproto-empty">No Goals here yet.</p>;
  return (
    <ul className="gproto-goal-list">
      {goals.map((goal, index) => (
        <GoalRow
          goal={goal}
          horizon={horizon}
          index={index}
          key={goal.id}
          onComplete={onComplete}
          onDelete={onDelete}
          onDrop={onDrop}
          onEdit={onEdit}
          onMove={onMove}
          total={goals.length}
        />
      ))}
    </ul>
  );
}

function GoalRow({
  goal,
  horizon,
  index,
  onComplete,
  onDelete,
  onDrop,
  onEdit,
  onMove,
  total,
}: {
  goal: PrototypeGoal;
  horizon: Horizon;
  index: number;
  onComplete: (goal: PrototypeGoal) => void;
  onDelete: (goal: PrototypeGoal) => void;
  onDrop: (horizon: Horizon, draggedId: string, targetId: string) => void;
  onEdit: (goal: PrototypeGoal) => void;
  onMove: (horizon: Horizon, id: string, direction: -1 | 1) => void;
  total: number;
}) {
  function startDrag(event: DragEvent<HTMLButtonElement>) {
    event.dataTransfer.setData("text/plain", `${horizon}:${goal.id}`);
    event.dataTransfer.effectAllowed = "move";
  }

  function drop(event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    const [sourceHorizon, sourceId] = event.dataTransfer.getData("text/plain").split(":");
    if (sourceHorizon === horizon && sourceId) onDrop(horizon, sourceId, goal.id);
  }

  function moveWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onMove(horizon, goal.id, event.key === "ArrowUp" ? -1 : 1);
  }

  return (
    <li className="gproto-goal-row" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
      <button
        aria-label={`Reorder ${goal.text}. Use arrow keys or drag.`}
        className="gproto-handle"
        draggable
        onDragStart={startDrag}
        onKeyDown={moveWithKeyboard}
        title="Drag to reorder. Arrow keys also work."
        type="button"
      >
        ⠿
      </button>
      <span className="gproto-goal-copy">{goal.text}</span>
      <button
        aria-label={`Mark ${goal.text} done`}
        className="gproto-done"
        onClick={() => onComplete(goal)}
        title="Mark Done"
        type="button"
      >
        ✓
      </button>
      <GoalMore goal={goal} onDelete={onDelete} onEdit={onEdit} />
      <span className="gproto-sr-only">Position {index + 1} of {total}</span>
    </li>
  );
}

function GoalCommands({
  goal,
  onComplete,
  onDelete,
  onEdit,
}: {
  goal: PrototypeGoal;
  onComplete: (goal: PrototypeGoal) => void;
  onDelete: (goal: PrototypeGoal) => void;
  onEdit: (goal: PrototypeGoal) => void;
}) {
  return (
    <span className="gproto-commands">
      <button aria-label={`Mark ${goal.text} done`} className="gproto-done" onClick={() => onComplete(goal)} type="button">✓</button>
      <GoalMore goal={goal} onDelete={onDelete} onEdit={onEdit} />
    </span>
  );
}

function GoalMore({
  goal,
  onDelete,
  onEdit,
}: {
  goal: PrototypeGoal;
  onDelete: (goal: PrototypeGoal) => void;
  onEdit: (goal: PrototypeGoal) => void;
}) {
  return (
    <details className="gproto-more">
      <summary aria-label={`More actions for ${goal.text}`} title="More actions">•••</summary>
      <span>
        <button onClick={() => onEdit(goal)} type="button">Edit</button>
        <button className="is-danger" onClick={() => onDelete(goal)} type="button">Delete</button>
      </span>
    </details>
  );
}

function LifecycleSections({
  completed,
  mode,
  onComplete,
  onDelete,
  onEdit,
  onRestore,
  upcoming,
}: {
  completed: PrototypeGoal[];
  mode: "overview" | "focus" | "sections";
  onComplete: (goal: PrototypeGoal) => void;
  onDelete: (goal: PrototypeGoal) => void;
  onEdit: (goal: PrototypeGoal) => void;
  onRestore: (goal: PrototypeGoal) => void;
  upcoming: PrototypeGoal[];
}) {
  if (!upcoming.length && !completed.length) return null;
  return (
    <div className={`gproto-lifecycle ${mode}`}>
      {upcoming.length > 0 && (
        <details>
          <summary>Upcoming <span>{upcoming.length}</span></summary>
          <ul>
            {upcoming.map((goal) => (
              <li key={goal.id}>
                <span><strong>{goal.text}</strong><small>{periodLabel(goal)}</small></span>
                <GoalCommands goal={goal} onComplete={onComplete} onDelete={onDelete} onEdit={onEdit} />
              </li>
            ))}
          </ul>
        </details>
      )}
      {completed.length > 0 && (
        <details>
          <summary>Completed Goals <span>{completed.length}</span></summary>
          <ul>
            {completed.map((goal) => (
              <li key={goal.id}>
                <span><strong>{goal.text}</strong><small>{periodLabel(goal)}</small></span>
                <span className="gproto-commands">
                  <button className="gproto-restore" onClick={() => onRestore(goal)} type="button">Restore</button>
                  <details className="gproto-more">
                    <summary aria-label={`More actions for ${goal.text}`}>•••</summary>
                    <span><button className="is-danger" onClick={() => onDelete(goal)} type="button">Delete</button></span>
                  </details>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function GoalForm({
  editor,
  onClose,
  onSave,
  presentation,
}: {
  editor: Editor;
  onClose: () => void;
  onSave: (draft: Omit<PrototypeGoal, "id" | "position">) => void;
  presentation: "modal" | "inline" | "panel";
}) {
  const [text, setText] = useState(editor.goal?.text ?? "");
  const [horizon, setHorizon] = useState<Horizon>(editor.goal?.horizon ?? editor.horizon);
  const [periodStart, setPeriodStart] = useState(editor.goal?.periodStart ?? "");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    onSave({
      horizon,
      periodStart: horizon === "someday" || !periodStart ? null : periodStart,
      text: text.trim(),
    });
  }

  return (
    <div className={`gproto-form-wrap ${presentation}`} role={presentation === "inline" ? undefined : "dialog"} aria-modal={presentation === "inline" ? undefined : true}>
      <form className="gproto-form" onSubmit={submit}>
        <header>
          <div>
            <p className="eyebrow">{editor.goal ? "Change" : "New"}</p>
            <h2>{editor.goal ? "Edit Goal" : "Add Goal"}</h2>
          </div>
          <button aria-label="Close Goal form" className="gproto-close" onClick={onClose} type="button">×</button>
        </header>
        <label className="field">
          <span>Finishable outcome</span>
          <input autoFocus maxLength={200} onChange={(event) => setText(event.target.value)} placeholder="What do you want to finish?" required value={text} />
        </label>
        <div className="gproto-form-fields">
          <label className="field">
            <span>Time group</span>
            <select onChange={(event) => setHorizon(event.target.value as Horizon)} value={horizon}>
              {horizons.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          {horizon !== "someday" && (
            <label className="field">
              <span>Date <small>Optional</small></span>
              <input onChange={(event) => setPeriodStart(event.target.value)} type="date" value={periodStart} />
            </label>
          )}
        </div>
        <footer>
          <button className="quiet-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-button" type="submit">{editor.goal ? "Save Goal" : "Add Goal"}</button>
        </footer>
      </form>
    </div>
  );
}

function VariantA(props: VariantProps) {
  return (
    <main className="page gproto-page gproto-a">
      <PrototypeHeader onAdd={() => props.onNew()} />
      <p className="gproto-fixture">Example data · Changes stay in this tab</p>
      <ReviewNotice goals={props.state.needsReview} onComplete={props.onComplete} onDelete={props.onDelete} onEdit={props.onEdit} open={props.reviewOpen} setOpen={props.setReviewOpen} />
      <div className="gproto-overview-grid">
        {horizons.map(({ key, label }) => (
          <section className="gproto-list-section" key={key}>
            <header><h2>{label}</h2><span>{props.state.goals[key].length}</span></header>
            <GoalList goals={props.state.goals[key]} horizon={key} onComplete={props.onComplete} onDelete={props.onDelete} onDrop={props.onDrop} onEdit={props.onEdit} onMove={props.onMove} />
          </section>
        ))}
      </div>
      <LifecycleSections completed={props.state.completed} mode="overview" onComplete={props.onComplete} onDelete={props.onDelete} onEdit={props.onEdit} onRestore={props.onRestore} upcoming={props.state.upcoming} />
      {props.editor && <GoalForm editor={props.editor} key={props.editor.goal?.id ?? "new"} onClose={props.onCloseEditor} onSave={props.onSave} presentation="modal" />}
    </main>
  );
}

function VariantB(props: VariantProps) {
  const [active, setActive] = useState<Horizon>("week");
  const label = horizons.find(({ key }) => key === active)?.label ?? "Week";
  return (
    <main className="page gproto-page gproto-b">
      <PrototypeHeader onAdd={() => props.onNew(active)} quiet />
      <p className="gproto-fixture">Example data · Changes stay in this tab</p>
      <ReviewNotice goals={props.state.needsReview} onComplete={props.onComplete} onDelete={props.onDelete} onEdit={props.onEdit} open={props.reviewOpen} setOpen={props.setReviewOpen} />
      {props.editor && <GoalForm editor={props.editor} key={props.editor.goal?.id ?? "new"} onClose={props.onCloseEditor} onSave={props.onSave} presentation="inline" />}
      <nav className="gproto-tabs" aria-label="Goal time groups">
        {horizons.map(({ key, label: horizonLabel }) => (
          <button aria-current={active === key ? "page" : undefined} key={key} onClick={() => setActive(key)} type="button">
            {horizonLabel}<span>{props.state.goals[key].length}</span>
          </button>
        ))}
      </nav>
      <section className="gproto-focus-list" aria-labelledby="prototype-focus-title">
        <header><div><p className="eyebrow">Current list</p><h2 id="prototype-focus-title">{label}</h2></div></header>
        <GoalList goals={props.state.goals[active]} horizon={active} onComplete={props.onComplete} onDelete={props.onDelete} onDrop={props.onDrop} onEdit={props.onEdit} onMove={props.onMove} />
      </section>
      <LifecycleSections completed={props.state.completed} mode="focus" onComplete={props.onComplete} onDelete={props.onDelete} onEdit={props.onEdit} onRestore={props.onRestore} upcoming={props.state.upcoming} />
    </main>
  );
}

function VariantC(props: VariantProps) {
  return (
    <main className="page gproto-page gproto-c">
      <PrototypeHeader onAdd={() => props.onNew()} />
      <p className="gproto-fixture">Example data · Changes stay in this tab</p>
      <ReviewNotice goals={props.state.needsReview} onComplete={props.onComplete} onDelete={props.onDelete} onEdit={props.onEdit} open={props.reviewOpen} setOpen={props.setReviewOpen} />
      <div className="gproto-accordions">
        {horizons.map(({ key, label }) => (
          <details key={key} open={key === "week"}>
            <summary><span>{label}<small>{preview(props.state.goals[key])}</small></span><strong>{props.state.goals[key].length}</strong></summary>
            <div>
              <GoalList goals={props.state.goals[key]} horizon={key} onComplete={props.onComplete} onDelete={props.onDelete} onDrop={props.onDrop} onEdit={props.onEdit} onMove={props.onMove} />
            </div>
          </details>
        ))}
      </div>
      <LifecycleSections completed={props.state.completed} mode="sections" onComplete={props.onComplete} onDelete={props.onDelete} onEdit={props.onEdit} onRestore={props.onRestore} upcoming={props.state.upcoming} />
      {props.editor && <GoalForm editor={props.editor} key={props.editor.goal?.id ?? "new"} onClose={props.onCloseEditor} onSave={props.onSave} presentation="panel" />}
    </main>
  );
}

function PrototypeSwitcher({ current, onChange }: { current: Variant; onChange: (variant: Variant) => void }) {
  if (!import.meta.env.DEV) return null;
  const keys: Variant[] = ["A", "B", "C"];
  const index = keys.indexOf(current);
  function cycle(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    onChange(keys[(index + direction + keys.length) % keys.length]);
  }
  return (
    <aside className="gproto-switcher" aria-label="Prototype variants" onKeyDown={cycle}>
      <button aria-label="Previous variant" onClick={() => onChange(keys[(index + keys.length - 1) % keys.length])} type="button">←</button>
      <strong>{current} — {variantNames[current]}</strong>
      <button aria-label="Next variant" onClick={() => onChange(keys[(index + 1) % keys.length])} type="button">→</button>
    </aside>
  );
}

function periodLabel(goal: PrototypeGoal) {
  if (!goal.periodStart) return "Someday";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${goal.periodStart}T12:00:00.000Z`));
}

function preview(goals: PrototypeGoal[]) {
  if (!goals.length) return "No Goals";
  const text = goals.slice(0, 2).map((goal) => goal.text).join(" · ");
  return goals.length > 2 ? `${text} · +${goals.length - 2}` : text;
}
