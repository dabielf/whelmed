import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../worker";

const now = () => new Date("2026-08-08T10:00:00.000Z");

function request(
  app: ReturnType<typeof createApp>,
  path: string,
  options: RequestInit = {},
  timeZone = "Europe/Paris",
) {
  const headers = new Headers(options.headers);
  if (timeZone) headers.set("x-time-zone", timeZone);
  if (options.body) headers.set("content-type", "application/json");
  return app.request(`http://localhost${path}`, { ...options, headers }, env);
}

async function createValue(app: ReturnType<typeof createApp>, name: string) {
  const response = await request(app, "/api/values", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return (await response.json<{ value: { id: string } }>()).value.id;
}

type ListedValue = {
  id: string;
  name: string;
  meaning: string | null;
  status: "active" | "paused";
  position: number;
};

async function listedValues(app: ReturnType<typeof createApp>) {
  const response = await request(app, "/api/values");
  expect(response.status).toBe(200);
  return (await response.json<{ values: ListedValue[] }>()).values;
}

async function createAction(
  app: ReturnType<typeof createApp>,
  primaryValueId: string,
  text: string,
  done: boolean,
  extraValueIds: string[] = [],
) {
  const response = await request(app, `/api/values/${primaryValueId}/actions`, {
    method: "POST",
    body: JSON.stringify({ text, done, extraValueIds }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ action: { id: string } }>()).action.id;
}

async function seedAction({
  id,
  date,
  text,
  status,
  values,
}: {
  id: string;
  date: string;
  text: string;
  status: "planned" | "done";
  values: { id: string; name: string; primary?: boolean }[];
}) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO daily_actions
         (id, action_date, text, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, date, text, status, `${date}T10:00:00.000Z`, `${date}T10:00:00.000Z`),
    ...values.map((value, index) => env.DB.prepare(
      `INSERT INTO daily_action_values
         (id, action_id, value_id, value_key, value_name, is_primary)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      `${id}-value-${index}`,
      id,
      value.id,
      `value:${value.id}`,
      value.name,
      value.primary === false ? 0 : 1,
    )),
  ]);
}

async function createMenuEntry(
  app: ReturnType<typeof createApp>,
  valueId: string,
  text: string,
) {
  const response = await request(app, `/api/values/${valueId}/menu`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ entry: { id: string } }>()).entry.id;
}

type Goal = {
  id: string;
  text: string;
  horizon: "week" | "month" | "year" | "someday";
  periodStart: string | null;
  position: number;
};

type GoalLists = Record<Goal["horizon"], Goal[]>;

async function createGoal(
  app: ReturnType<typeof createApp>,
  horizon: Goal["horizon"],
  text: string,
  periodStart?: string,
) {
  const response = await request(app, "/api/goals", {
    method: "POST",
    body: JSON.stringify({ horizon, text, periodStart }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ goal: Goal }>()).goal;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM goals"),
    env.DB.prepare("DELETE FROM daily_action_values"),
    env.DB.prepare("DELETE FROM daily_actions"),
    env.DB.prepare("DELETE FROM app_values"),
    env.DB.prepare(
      "UPDATE settings SET app_time_zone = NULL, updated_at = '2026-08-08T00:00:00.000Z' WHERE id = 1",
    ),
  ]);
});

describe("first Value-aligned Action", () => {
  it("creates a Value and keeps its Done action in D1", async () => {
    const app = createApp(now);
    const valueResponse = await request(app, "/api/values", {
      method: "POST",
      body: JSON.stringify({ name: "Care", meaning: "Treat myself gently" }),
    });
    expect(valueResponse.status).toBe(201);
    const { value } = await valueResponse.json<{ value: { id: string } }>();

    let todayResponse = await request(app, "/api/today");
    expect(await todayResponse.json()).toEqual({
      date: "2026-08-08",
      timeZone: {
        appTimeZone: null,
        effectiveTimeZone: "Europe/Paris",
        needsConfirmation: true,
      },
      goals: { week: [], month: [], year: [], someday: [] },
      needsReviewCount: 0,
      values: [
        expect.objectContaining({
          id: value.id,
          name: "Care",
          meaning: "Treat myself gently",
          actions: [],
        }),
      ],
    });

    const actionResponse = await request(
      app,
      `/api/values/${value.id}/actions`,
      {
        method: "POST",
        body: JSON.stringify({ text: "Drink a glass of water", done: true }),
      },
    );
    expect(actionResponse.status).toBe(201);

    todayResponse = await request(createApp(now), "/api/today");
    const today = await todayResponse.json<{
      values: { actions: { text: string; status: string }[] }[];
    }>();
    expect(today.values[0].actions).toEqual([
      expect.objectContaining({
        text: "Drink a glass of water",
        status: "done",
      }),
    ]);
  });

  it("rejects empty and duplicate Value names", async () => {
    const app = createApp(now);
    const empty = await request(app, "/api/values", {
      method: "POST",
      body: JSON.stringify({ name: "  " }),
    });
    expect(empty.status).toBe(400);

    await request(app, "/api/values", {
      method: "POST",
      body: JSON.stringify({ name: "Care" }),
    });
    const duplicate = await request(app, "/api/values", {
      method: "POST",
      body: JSON.stringify({ name: "care" }),
    });
    expect(duplicate.status).toBe(409);
  });

  it("fails closed away from local development", async () => {
    const response = await createApp(now).request(
      "https://whelmed.example/api/today",
      { headers: { "x-time-zone": "Europe/Paris" } },
      env,
    );
    expect(response.status).toBe(403);
  });

  it("plans, edits, re-links, completes, re-plans, and deletes Today's action", async () => {
    const app = createApp(now);
    const careId = await createValue(app, "Care");
    const connectionId = await createValue(app, "Connection");

    const createdResponse = await request(
      app,
      `/api/values/${careId}/actions`,
      {
        method: "POST",
        body: JSON.stringify({
          text: "Message Lee",
          done: false,
          extraValueIds: [connectionId],
        }),
      },
    );
    expect(createdResponse.status).toBe(201);
    const { action } = await createdResponse.json<{ action: { id: string } }>();

    let today = await (await request(app, "/api/today")).json<{
      values: {
        id: string;
        actions: {
          id: string;
          text: string;
          status: string;
          values: { id: string; name: string; isPrimary: boolean }[];
        }[];
      }[];
    }>();
    expect(today.values.find((value) => value.id === careId)?.actions).toEqual([
      expect.objectContaining({
        id: action.id,
        status: "planned",
        values: [
          { id: careId, name: "Care", isPrimary: true },
          { id: connectionId, name: "Connection", isPrimary: false },
        ],
      }),
    ]);
    expect(
      today.values.find((value) => value.id === connectionId)?.actions,
    ).toEqual([]);

    const removedExtra = await request(app, `/api/actions/${action.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        text: "Send Lee a kind message",
        done: false,
        primaryValueId: careId,
        extraValueIds: [],
      }),
    });
    expect(removedExtra.status).toBe(200);
    today = await (await request(app, "/api/today")).json<typeof today>();
    expect(today.values.find((value) => value.id === careId)?.actions[0]).toEqual(
      expect.objectContaining({
        text: "Send Lee a kind message",
        status: "planned",
        values: [{ id: careId, name: "Care", isPrimary: true }],
      }),
    );

    const completed = await request(app, `/api/actions/${action.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        text: "Send Lee a kind message",
        done: true,
        primaryValueId: connectionId,
        extraValueIds: [careId],
      }),
    });
    expect(completed.status).toBe(200);
    today = await (await request(app, "/api/today")).json<typeof today>();
    expect(today.values.find((value) => value.id === careId)?.actions).toEqual([]);
    expect(
      today.values.find((value) => value.id === connectionId)?.actions[0],
    ).toEqual(expect.objectContaining({ status: "done" }));

    const replanned = await request(app, `/api/actions/${action.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        text: "Send Lee a kind message",
        done: false,
        primaryValueId: connectionId,
        extraValueIds: [careId],
      }),
    });
    expect(replanned.status).toBe(200);
    today = await (await request(app, "/api/today")).json<typeof today>();
    expect(
      today.values.find((value) => value.id === connectionId)?.actions[0],
    ).toEqual(expect.objectContaining({ status: "planned" }));

    expect(
      (await request(app, `/api/actions/${action.id}`, { method: "DELETE" }))
        .status,
    ).toBe(204);
    today = await (await request(app, "/api/today")).json<typeof today>();
    expect(today.values.every((value) => value.actions.length === 0)).toBe(true);
  });

  it("rejects invalid action text, state, and Value links", async () => {
    const app = createApp(now);
    const careId = await createValue(app, "Care");
    const connectionId = await createValue(app, "Connection");
    const actionPath = `/api/values/${careId}/actions`;

    expect(
      (
        await request(app, actionPath, {
          method: "POST",
          body: JSON.stringify({ text: "  ", done: true }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app, actionPath, {
          method: "POST",
          body: JSON.stringify({ text: "Rest", done: "yes" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app, actionPath, {
          method: "POST",
          body: JSON.stringify({
            text: "Rest",
            done: true,
            extraValueIds: [connectionId, connectionId],
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app, actionPath, {
          method: "POST",
          body: JSON.stringify({
            text: "Rest",
            done: true,
            extraValueIds: ["missing-value"],
          }),
        })
      ).status,
    ).toBe(400);

    const created = await request(app, actionPath, {
      method: "POST",
      body: JSON.stringify({ text: "Rest", done: true }),
    });
    const { action } = await created.json<{ action: { id: string } }>();
    expect(
      (
        await request(app, `/api/actions/${action.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            text: "Rest",
            done: "yes",
            primaryValueId: careId,
            extraValueIds: [],
          }),
        })
      ).status,
    ).toBe(400);
  });
});

describe("fluid Values", () => {
  it("lists Active and Paused Values in one stable order", async () => {
    const app = createApp(now);
    const careId = await createValue(app, "Care");
    const connectionId = await createValue(app, "Connection");
    const learningId = await createValue(app, "Learning");

    const pauseResponse = await request(app, `/api/values/${connectionId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
    });
    expect(pauseResponse.status).toBe(200);

    expect(await listedValues(app)).toEqual([
      {
        id: careId,
        name: "Care",
        meaning: null,
        status: "active",
        position: 0,
      },
      {
        id: connectionId,
        name: "Connection",
        meaning: null,
        status: "paused",
        position: 1,
      },
      {
        id: learningId,
        name: "Learning",
        meaning: null,
        status: "active",
        position: 2,
      },
    ]);
  });

  it("edits a Value and renames its existing action snapshots", async () => {
    const app = createApp(now);
    const valueId = await createValue(app, "Rest");
    await request(app, `/api/values/${valueId}/actions`, {
      method: "POST",
      body: JSON.stringify({ text: "Took a real break", done: true }),
    });

    const response = await request(app, `/api/values/${valueId}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Care",
        meaning: "Treat myself gently",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      value: {
        id: valueId,
        name: "Care",
        meaning: "Treat myself gently",
        status: "active",
        position: 0,
      },
    });
    expect((await listedValues(app))[0]).toEqual({
      id: valueId,
      name: "Care",
      meaning: "Treat myself gently",
      status: "active",
      position: 0,
    });
    expect(
      await env.DB.prepare(
        "SELECT value_name FROM daily_action_values WHERE value_id = ?",
      )
        .bind(valueId)
        .first(),
    ).toEqual({ value_name: "Care" });
  });

  it("reorders the complete Value list and rejects partial lists", async () => {
    const app = createApp(now);
    const careId = await createValue(app, "Care");
    const connectionId = await createValue(app, "Connection");
    const learningId = await createValue(app, "Learning");

    expect(
      (
        await request(app, "/api/values/order", {
          method: "PUT",
          body: JSON.stringify({ ids: [learningId, careId] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app, "/api/values/order", {
          method: "PUT",
          body: JSON.stringify({ ids: [learningId, careId, "missing"] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app, "/api/values/order", {
          method: "PUT",
          body: JSON.stringify({ ids: [learningId, learningId, careId] }),
        })
      ).status,
    ).toBe(400);

    const response = await request(app, "/api/values/order", {
      method: "PUT",
      body: JSON.stringify({ ids: [learningId, careId, connectionId] }),
    });
    expect(response.status).toBe(200);
    expect((await listedValues(app)).map(({ id, position }) => ({ id, position }))).toEqual([
      { id: learningId, position: 0 },
      { id: careId, position: 1 },
      { id: connectionId, position: 2 },
    ]);
    const today = await (await request(app, "/api/today")).json<{
      values: { id: string }[];
    }>();
    expect(today.values.map(({ id }) => id)).toEqual([
      learningId,
      careId,
      connectionId,
    ]);
  });

  it("pauses and restores a Value without losing its place, menu, or Done actions", async () => {
    const app = createApp(now);
    const careId = await createValue(app, "Care");
    const connectionId = await createValue(app, "Connection");
    const learningId = await createValue(app, "Learning");
    await env.DB.prepare(
      `INSERT INTO action_menu_entries
         (id, value_id, text, position, created_at, updated_at)
       VALUES ('menu-care', ?, 'Take a break', 0, ?, ?)`,
    )
      .bind(careId, now().toISOString(), now().toISOString())
      .run();

    const plannedPrimaryId = await createAction(
      app,
      careId,
      "Rest later",
      false,
    );
    const plannedExtraId = await createAction(
      app,
      connectionId,
      "Message someone",
      false,
      [careId],
    );
    const donePrimaryId = await createAction(app, careId, "Rested", true);
    const doneExtraId = await createAction(
      app,
      connectionId,
      "Had a kind talk",
      true,
      [careId],
    );

    expect(
      (
        await request(app, `/api/values/${careId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "paused" }),
        })
      ).status,
    ).toBe(200);
    expect(await listedValues(app)).toEqual([
      expect.objectContaining({ id: careId, status: "paused", position: 0 }),
      expect.objectContaining({ id: connectionId, status: "active", position: 1 }),
      expect.objectContaining({ id: learningId, status: "active", position: 2 }),
    ]);

    const storedActions = await env.DB.prepare(
      "SELECT id, status FROM daily_actions ORDER BY text",
    ).all<{ id: string; status: string }>();
    expect(storedActions.results.map(({ id }) => id).sort()).toEqual(
      [plannedExtraId, donePrimaryId, doneExtraId].sort(),
    );
    expect(storedActions.results.some(({ id }) => id === plannedPrimaryId)).toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT value_id FROM daily_action_values WHERE action_id = ? AND value_id = ?",
      )
        .bind(plannedExtraId, careId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT value_id FROM daily_action_values WHERE action_id = ? AND value_id = ?",
      )
        .bind(doneExtraId, careId)
        .first(),
    ).toEqual({ value_id: careId });
    expect(
      await env.DB.prepare(
        "SELECT id FROM action_menu_entries WHERE value_id = ?",
      )
        .bind(careId)
        .first(),
    ).toEqual({ id: "menu-care" });

    let today = await (await request(app, "/api/today")).json<{
      values: { id: string; actions: { id: string }[] }[];
    }>();
    expect(today.values.map(({ id }) => id)).toEqual([connectionId, learningId]);

    expect(
      (
        await request(app, `/api/values/${careId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "active" }),
        })
      ).status,
    ).toBe(200);
    today = await (await request(app, "/api/today")).json<typeof today>();
    expect(today.values.map(({ id }) => id)).toEqual([
      careId,
      connectionId,
      learningId,
    ]);
    expect(today.values[0].actions.map(({ id }) => id)).toEqual([donePrimaryId]);
    expect(
      today.values[1].actions.some(({ id }) => id === plannedExtraId),
    ).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT id FROM action_menu_entries WHERE value_id = ?",
      )
        .bind(careId)
        .first(),
    ).toEqual({ id: "menu-care" });
  });

  it("deletes a Value and its menu while preserving Done snapshots", async () => {
    const app = createApp(now);
    const careId = await createValue(app, "Care");
    const connectionId = await createValue(app, "Connection");
    await env.DB.prepare(
      `INSERT INTO action_menu_entries
         (id, value_id, text, position, created_at, updated_at)
       VALUES ('menu-care', ?, 'Take a break', 0, ?, ?)`,
    )
      .bind(careId, now().toISOString(), now().toISOString())
      .run();

    const plannedPrimaryId = await createAction(app, careId, "Rest later", false);
    const plannedExtraId = await createAction(
      app,
      connectionId,
      "Message someone",
      false,
      [careId],
    );
    const donePrimaryId = await createAction(app, careId, "Rested", true);
    const doneExtraId = await createAction(
      app,
      connectionId,
      "Had a kind talk",
      true,
      [careId],
    );

    const response = await request(app, `/api/values/${careId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    expect((await listedValues(app)).map(({ id }) => id)).toEqual([connectionId]);

    const storedActions = await env.DB.prepare(
      "SELECT id FROM daily_actions ORDER BY id",
    ).all<{ id: string }>();
    expect(storedActions.results.map(({ id }) => id).sort()).toEqual(
      [plannedExtraId, donePrimaryId, doneExtraId].sort(),
    );
    expect(storedActions.results.some(({ id }) => id === plannedPrimaryId)).toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT value_id FROM daily_action_values WHERE action_id = ? AND value_name = 'Care'",
      )
        .bind(plannedExtraId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT value_id, value_name, is_primary
         FROM daily_action_values
         WHERE action_id = ? AND value_name = 'Care'`,
      )
        .bind(donePrimaryId)
        .first(),
    ).toEqual({ value_id: null, value_name: "Care", is_primary: 1 });
    expect(
      await env.DB.prepare(
        `SELECT value_id, value_name, is_primary
         FROM daily_action_values
         WHERE action_id = ? AND value_name = 'Care'`,
      )
        .bind(doneExtraId)
        .first(),
    ).toEqual({ value_id: null, value_name: "Care", is_primary: 0 });
    expect(
      await env.DB.prepare("SELECT id FROM action_menu_entries WHERE value_id = ?")
        .bind(careId)
        .first(),
    ).toBeNull();

    const today = await (await request(app, "/api/today")).json<{
      values: { id: string; actions: { id: string }[] }[];
    }>();
    expect(today.values).toEqual([
      expect.objectContaining({
        id: connectionId,
        actions: expect.arrayContaining([
          expect.objectContaining({ id: plannedExtraId }),
          expect.objectContaining({ id: doneExtraId }),
        ]),
      }),
    ]);
  });

  it("rejects invalid Value changes without changing stored data", async () => {
    const app = createApp(now);
    const careId = await createValue(app, "Care");
    await createValue(app, "Connection");

    for (const body of [
      {},
      { name: "  " },
      { meaning: "x".repeat(501) },
      { status: "deleted" },
    ]) {
      expect(
        (
          await request(app, `/api/values/${careId}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request(app, `/api/values/${careId}`, {
          method: "PATCH",
          body: JSON.stringify({ name: "connection" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (await request(app, "/api/values/missing", { method: "DELETE" })).status,
    ).toBe(404);
    expect((await listedValues(app))[0]).toEqual(
      expect.objectContaining({ id: careId, name: "Care", meaning: null }),
    );
  });
});

describe("Action Menus", () => {
  it("adds at the bottom, edits, filters, fully reorders, and deletes entries", async () => {
    const app = createApp(now);
    const valueId = await createValue(app, "Care");
    const waterId = await createMenuEntry(app, valueId, "Drink water");
    const outsideId = await createMenuEntry(app, valueId, "Step outside");
    const restId = await createMenuEntry(app, valueId, "Take a real break");

    expect(await (await request(app, `/api/values/${valueId}/menu`)).json()).toEqual({
      entries: [
        { id: waterId, text: "Drink water", position: 0 },
        { id: outsideId, text: "Step outside", position: 1 },
        { id: restId, text: "Take a real break", position: 2 },
      ],
    });

    const edited = await request(app, `/api/menu/${outsideId}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "Go outside for five minutes" }),
    });
    expect(edited.status).toBe(200);
    expect(
      await (await request(app, `/api/values/${valueId}/menu?q=OUTside`)).json(),
    ).toEqual({
      entries: [
        { id: outsideId, text: "Go outside for five minutes", position: 1 },
      ],
    });

    for (const ids of [
      [restId, waterId],
      [restId, waterId, "missing"],
      [restId, restId, waterId],
      [restId, waterId, outsideId, outsideId],
    ]) {
      expect(
        (
          await request(app, `/api/values/${valueId}/menu/order`, {
            method: "PUT",
            body: JSON.stringify({ ids }),
          })
        ).status,
      ).toBe(400);
    }

    const reordered = await request(app, `/api/values/${valueId}/menu/order`, {
      method: "PUT",
      body: JSON.stringify({ ids: [restId, waterId, outsideId] }),
    });
    expect(reordered.status).toBe(200);
    expect(
      (await reordered.json<{ entries: { id: string; position: number }[] }>()).entries,
    ).toEqual([
      expect.objectContaining({ id: restId, position: 0 }),
      expect.objectContaining({ id: waterId, position: 1 }),
      expect.objectContaining({ id: outsideId, position: 2 }),
    ]);

    expect(
      (await request(app, `/api/menu/${waterId}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await (await request(app, `/api/values/${valueId}/menu`)).json<{
        entries: { id: string }[];
      }>()).entries.map(({ id }) => id),
    ).toEqual([restId, outsideId]);
  });

  it("copies menu wording into an independent action and saves separate reusable copies", async () => {
    const app = createApp(now);
    const careId = await createValue(app, "Care");
    const connectionId = await createValue(app, "Connection");
    const menuId = await createMenuEntry(app, careId, "Take a real break");

    const copiedAction = await request(app, `/api/values/${careId}/actions`, {
      method: "POST",
      body: JSON.stringify({
        text: "Take a real break",
        done: true,
        extraValueIds: [],
      }),
    });
    expect(copiedAction.status).toBe(201);
    expect(
      (
        await request(app, `/api/menu/${menuId}`, {
          method: "PATCH",
          body: JSON.stringify({ text: "Rest for ten minutes" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(app, `/api/menu/${menuId}`, { method: "DELETE" })).status,
    ).toBe(204);
    const today = await (await request(app, "/api/today")).json<{
      values: { id: string; actions: { text: string }[] }[];
    }>();
    expect(today.values.find(({ id }) => id === careId)?.actions).toEqual([
      expect.objectContaining({ text: "Take a real break" }),
    ]);

    const savedAction = await request(app, `/api/values/${careId}/actions`, {
      method: "POST",
      body: JSON.stringify({
        text: "Send one honest message",
        done: false,
        extraValueIds: [connectionId],
        saveForReuse: true,
      }),
    });
    expect(savedAction.status).toBe(201);
    const careMenu = await (await request(app, `/api/values/${careId}/menu`)).json<{
      entries: { id: string; text: string }[];
    }>();
    const connectionMenu = await (
      await request(app, `/api/values/${connectionId}/menu`)
    ).json<typeof careMenu>();
    expect(careMenu.entries).toEqual([
      expect.objectContaining({ text: "Send one honest message" }),
    ]);
    expect(connectionMenu.entries).toEqual([
      expect.objectContaining({ text: "Send one honest message" }),
    ]);
    expect(careMenu.entries[0].id).not.toBe(connectionMenu.entries[0].id);

    await request(app, `/api/menu/${careMenu.entries[0].id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "Send a short message" }),
    });
    expect(
      await (await request(app, `/api/values/${connectionId}/menu`)).json(),
    ).toEqual(connectionMenu);
  });
});

describe("current Goals", () => {
  it("keeps future Week, Month, and Year Goals in Upcoming", async () => {
    const app = createApp(now);
    const current = await createGoal(app, "week", "Send one application");
    const futureWeek = await createGoal(app, "week", "Take a quiet week", "2026-08-16");
    const futureMonth = await createGoal(app, "month", "Book a break", "2026-09-14");
    const futureYear = await createGoal(app, "year", "Move closer to trees", "2027-06-12");

    expect(current.periodStart).toBe("2026-08-03");
    expect(futureWeek.periodStart).toBe("2026-08-10");
    expect(futureMonth.periodStart).toBe("2026-09-01");
    expect(futureYear.periodStart).toBe("2027-01-01");

    const response = await request(app, "/api/goals");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      goals: expect.objectContaining({ week: [current] }),
      upcoming: [futureWeek, futureMonth, futureYear],
    }));

    expect(await (await request(app, "/api/today")).json()).toEqual(
      expect.objectContaining({
        goals: expect.objectContaining({ week: [current] }),
      }),
    );
  });

  it("moves periods from Upcoming to current, then to Needs Review at each boundary", async () => {
    const setup = createApp(now);
    const oldWeek = await createGoal(setup, "week", "Finish the old week");
    const nextWeek = await createGoal(setup, "week", "Start the next week", "2026-08-10");
    const oldMonth = await createGoal(setup, "month", "Finish August");
    const nextMonth = await createGoal(setup, "month", "Start September", "2026-09-01");
    const oldYear = await createGoal(setup, "year", "Finish 2026");
    const nextYear = await createGoal(setup, "year", "Start 2027", "2027-01-01");
    const someday = await createGoal(setup, "someday", "Learn pottery");

    const monday = createApp(() => new Date("2026-08-10T10:00:00.000Z"));
    const mondayGoals = await (await request(monday, "/api/goals")).json<{
      goals: GoalLists;
      upcoming: Goal[];
      needsReview: Goal[];
    }>();
    expect(mondayGoals.goals.week).toEqual([nextWeek]);
    expect(mondayGoals.needsReview).toEqual([oldWeek]);
    expect(mondayGoals.upcoming).toEqual([nextMonth, nextYear]);

    const today = await (await request(monday, "/api/today")).json<{
      goals: GoalLists;
      needsReviewCount: number;
    }>();
    expect(today.needsReviewCount).toBe(1);
    expect(today.goals.week).toEqual([nextWeek]);
    expect(JSON.stringify(today)).not.toContain(oldWeek.text);

    const september = createApp(() => new Date("2026-09-01T10:00:00.000Z"));
    const septemberGoals = await (await request(september, "/api/goals")).json<{
      goals: GoalLists;
      needsReview: Goal[];
    }>();
    expect(septemberGoals.goals.month).toEqual([nextMonth]);
    expect(septemberGoals.needsReview).toEqual([oldWeek, nextWeek, oldMonth]);

    const newYear = createApp(() => new Date("2027-01-01T10:00:00.000Z"));
    const newYearGoals = await (await request(newYear, "/api/goals")).json<{
      goals: GoalLists;
      needsReview: Goal[];
    }>();
    expect(newYearGoals.goals.year).toEqual([nextYear]);
    expect(newYearGoals.goals.someday).toEqual([someday]);
    expect(newYearGoals.needsReview).toEqual([
      oldWeek,
      nextWeek,
      oldMonth,
      nextMonth,
      oldYear,
    ]);
  });

  it("keeps expired Goals in Needs Review until an explicit move, Done, or Delete choice", async () => {
    const setup = createApp(now);
    const moveCurrent = await createGoal(setup, "week", "Move to this week");
    const moveFuture = await createGoal(setup, "week", "Move to September");
    const moveSomeday = await createGoal(setup, "week", "Keep without a date");
    const markDone = await createGoal(setup, "week", "Already finished");
    const remove = await createGoal(setup, "week", "No longer useful");
    const monday = createApp(() => new Date("2026-08-10T10:00:00.000Z"));

    let listed = await (await request(monday, "/api/goals")).json<{
      goals: GoalLists;
      needsReview: Goal[];
    }>();
    expect(listed.goals.someday).toEqual([]);
    expect(listed.needsReview).toEqual([
      moveCurrent,
      moveFuture,
      moveSomeday,
      markDone,
      remove,
    ]);

    expect((await request(monday, `/api/goals/${moveCurrent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "move", horizon: "week" }),
    })).status).toBe(200);
    expect((await request(monday, `/api/goals/${moveFuture.id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "move", horizon: "month", periodStart: "2026-09-14" }),
    })).status).toBe(200);
    expect((await request(monday, `/api/goals/${moveSomeday.id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "move", horizon: "someday" }),
    })).status).toBe(200);
    expect((await request(monday, `/api/goals/${markDone.id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "complete" }),
    })).status).toBe(200);
    expect((await request(monday, `/api/goals/${remove.id}`, {
      method: "DELETE",
    })).status).toBe(204);

    listed = await (await request(monday, "/api/goals")).json<typeof listed & {
      upcoming: Goal[];
      completed: Goal[];
    }>();
    expect(listed.goals.week).toEqual([{ ...moveCurrent, periodStart: "2026-08-10", position: 0 }]);
    expect(listed.goals.someday).toEqual([{ ...moveSomeday, horizon: "someday", periodStart: null, position: 0 }]);
    expect(listed.upcoming).toEqual([{ ...moveFuture, horizon: "month", periodStart: "2026-09-01", position: 0 }]);
    expect(listed.completed).toEqual([markDone]);
    expect(listed.needsReview).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain(remove.id);
  });

  it("removes Done Goals, restores current periods, and reviews every other dated period", async () => {
    const setup = createApp(now);
    const current = await createGoal(setup, "week", "Send one application");
    const future = await createGoal(setup, "month", "Book a September break", "2026-09-01");
    const someday = await createGoal(setup, "someday", "Learn pottery");

    for (const goal of [current, future, someday]) {
      expect((await request(setup, `/api/goals/${goal.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "complete" }),
      })).status).toBe(200);
    }
    let listed = await (await request(setup, "/api/goals")).json<{
      goals: GoalLists;
      upcoming: Goal[];
      completed: Goal[];
      needsReview: Goal[];
    }>();
    expect(listed.goals).toEqual({ week: [], month: [], year: [], someday: [] });
    expect(listed.upcoming).toEqual([]);
    expect(listed.completed).toEqual([current, future, someday]);
    expect((await (await request(setup, "/api/today")).json<{
      goals: GoalLists;
    }>()).goals).toEqual({ week: [], month: [], year: [], someday: [] });

    for (const goal of [current, future, someday]) {
      expect((await request(setup, `/api/goals/${goal.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "restore" }),
      })).status).toBe(200);
    }
    listed = await (await request(setup, "/api/goals")).json<typeof listed>();
    expect(listed.goals.week).toEqual([current]);
    expect(listed.goals.someday).toEqual([someday]);
    expect(listed.upcoming).toEqual([]);
    expect(listed.completed).toEqual([]);
    expect(listed.needsReview).toEqual([future]);

    await request(setup, `/api/goals/${current.id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "complete" }),
    });
    const monday = createApp(() => new Date("2026-08-10T10:00:00.000Z"));
    expect((await request(monday, `/api/goals/${current.id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "restore" }),
    })).status).toBe(200);

    const afterOutdatedRestore = await (await request(monday, "/api/goals")).json<{
      needsReview: Goal[];
    }>();
    expect(afterOutdatedRestore.needsReview).toContainEqual(current);
  });

  it("creates several Goals at the bottom of each current Goal List", async () => {
    const app = createApp(now);

    for (const body of [
      { horizon: "week", text: "  " },
      { horizon: "week", text: "x".repeat(201) },
      { horizon: "decade", text: "Build a cabin" },
      { horizon: ["week"], text: "Build a cabin" },
      { horizon: "week", text: "Build a cabin", periodStart: "2026-02-31" },
      { horizon: "week", text: "Build a cabin", periodStart: "2026-08-02" },
      { horizon: "someday", text: "Build a cabin", periodStart: "2027-01-01" },
    ]) {
      expect((await request(app, "/api/goals", {
        method: "POST",
        body: JSON.stringify(body),
      })).status).toBe(400);
    }

    const firstWeek = await createGoal(app, "week", "Send one application");
    const secondWeek = await createGoal(app, "week", "Book the dentist");
    const month = await createGoal(app, "month", "Choose a CV direction");
    const year = await createGoal(app, "year", "Move closer to trees");
    const someday = await createGoal(app, "someday", "Learn pottery");

    expect(await (await request(app, "/api/goals")).json()).toEqual({
      goals: {
        week: [
          { ...firstWeek, periodStart: "2026-08-03", position: 0 },
          { ...secondWeek, periodStart: "2026-08-03", position: 1 },
        ],
        month: [{ ...month, periodStart: "2026-08-01", position: 0 }],
        year: [{ ...year, periodStart: "2026-01-01", position: 0 }],
        someday: [{ ...someday, periodStart: null, position: 0 }],
      },
      completed: [],
      needsReview: [],
      upcoming: [],
    });
  });

  it("fully reorders one current Goal List and returns all current Goals on Today", async () => {
    const app = createApp(now);
    const first = await createGoal(app, "week", "Send one application");
    const second = await createGoal(app, "week", "Book the dentist");
    const third = await createGoal(app, "week", "Call the landlord");
    const month = await createGoal(app, "month", "Choose a CV direction");

    for (const ids of [
      [third.id, first.id],
      [third.id, first.id, "missing"],
      [third.id, third.id, first.id],
      [third.id, first.id, month.id],
    ]) {
      expect((await request(app, "/api/goals/order", {
        method: "PUT",
        body: JSON.stringify({ horizon: "week", ids }),
      })).status).toBe(400);
    }

    const reordered = await request(app, "/api/goals/order", {
      method: "PUT",
      body: JSON.stringify({
        horizon: "week",
        ids: [third.id, first.id, second.id],
      }),
    });
    expect(reordered.status).toBe(200);
    expect(await reordered.json()).toEqual({
      goals: [
        { ...third, position: 0 },
        { ...first, position: 1 },
        { ...second, position: 2 },
      ],
    });

    const today = await (await request(app, "/api/today")).json<{
      goals: Record<Goal["horizon"], Goal[]>;
    }>();
    expect(today.goals).toEqual({
      week: [
        { ...third, position: 0 },
        { ...first, position: 1 },
        { ...second, position: 2 },
      ],
      month: [month],
      year: [],
      someday: [],
    });
  });

  it("moves an expired Goal out of the current Goal Lists", async () => {
    const app = createApp(now);
    await env.DB.prepare(
      `INSERT INTO goals
         (id, text, horizon, period_start, status, position,
          completed_at, created_at, updated_at)
       VALUES ('old-week', 'Finished last week', 'week', '2026-07-27',
         'active', 0, NULL, '2026-07-27T00:00:00.000Z',
         '2026-07-27T00:00:00.000Z')`,
    ).run();

    const response = await request(app, "/api/goals");
    expect(response.status).toBe(200);
    expect((await response.json<{ goals: GoalLists }>()).goals.week).toEqual([]);
    expect(await env.DB.prepare(
      "SELECT status FROM goals WHERE id = 'old-week'",
    ).first()).toEqual({ status: "needs_review" });
  });
});

describe("read-only History", () => {
  it("returns only Done actions from past days in an inclusive range", async () => {
    const app = createApp(now);
    const careId = await createValue(app, "Care");
    await seedAction({
      id: "outside-range",
      date: "2026-07-31",
      text: "Outside",
      status: "done",
      values: [{ id: careId, name: "Care" }],
    });
    await seedAction({
      id: "past-done",
      date: "2026-08-01",
      text: "Took a real break",
      status: "done",
      values: [{ id: careId, name: "Care" }],
    });
    await seedAction({
      id: "past-planned",
      date: "2026-08-02",
      text: "Read later",
      status: "planned",
      values: [{ id: careId, name: "Care" }],
    });
    await seedAction({
      id: "today-done",
      date: "2026-08-08",
      text: "Today",
      status: "done",
      values: [{ id: careId, name: "Care" }],
    });

    const response = await request(
      app,
      "/api/history?start=2026-08-01&end=2026-08-07",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      start: "2026-08-01",
      end: "2026-08-07",
      counts: [{
        key: `value:${careId}`,
        id: careId,
        name: "Care",
        count: 1,
        deleted: false,
      }],
      actions: [{
        id: "past-done",
        date: "2026-08-01",
        text: "Took a real break",
        values: [{
          key: `value:${careId}`,
          id: careId,
          name: "Care",
          deleted: false,
        }],
      }],
    });
  });

  it("keeps per-Value counts while filtering multi-Value actions in place", async () => {
    const app = createApp(now);
    const careId = await createValue(app, "Care");
    const connectionId = await createValue(app, "Connection");
    await seedAction({
      id: "care-only",
      date: "2026-08-01",
      text: "Took a real break",
      status: "done",
      values: [{ id: careId, name: "Care" }],
    });
    await seedAction({
      id: "care-and-connection",
      date: "2026-08-02",
      text: "Had a kind talk",
      status: "done",
      values: [
        { id: careId, name: "Care" },
        { id: connectionId, name: "Connection", primary: false },
      ],
    });
    await seedAction({
      id: "connection-only",
      date: "2026-07-10",
      text: "Sent a voice note",
      status: "done",
      values: [{ id: connectionId, name: "Connection" }],
    });

    const response = await request(
      app,
      `/api/history?start=2026-07-09&end=2026-08-07&value=${encodeURIComponent(`value:${connectionId}`)}`,
    );
    expect(response.status).toBe(200);
    const history = await response.json<{
      counts: { key: string; name: string; count: number }[];
      actions: {
        id: string;
        values: { key: string; name: string }[];
      }[];
    }>();
    expect(history.counts).toEqual([
      expect.objectContaining({ key: `value:${careId}`, name: "Care", count: 2 }),
      expect.objectContaining({ key: `value:${connectionId}`, name: "Connection", count: 2 }),
    ]);
    expect(history.actions.map(({ id }) => id)).toEqual([
      "care-and-connection",
      "connection-only",
    ]);
    expect(history.actions[0].values).toEqual([
      expect.objectContaining({ key: `value:${careId}`, name: "Care" }),
      expect.objectContaining({ key: `value:${connectionId}`, name: "Connection" }),
    ]);
  });

  it("uses current names for live Values and the last name after deletion", async () => {
    const app = createApp(now);
    const valueId = await createValue(app, "Rest");
    await seedAction({
      id: "renamed-value-action",
      date: "2026-08-01",
      text: "Stopped for lunch",
      status: "done",
      values: [{ id: valueId, name: "Rest" }],
    });

    expect((await request(app, `/api/values/${valueId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Care" }),
    })).status).toBe(200);
    let history = await (await request(
      app,
      "/api/history?start=2026-08-01&end=2026-08-07",
    )).json<{
      counts: { key: string; id: string | null; name: string; deleted: boolean }[];
      actions: { values: { key: string; id: string | null; name: string; deleted: boolean }[] }[];
    }>();
    expect(history.counts).toEqual([
      expect.objectContaining({
        key: `value:${valueId}`,
        id: valueId,
        name: "Care",
        deleted: false,
      }),
    ]);
    expect(history.actions[0].values[0]).toEqual(expect.objectContaining({
      name: "Care",
      deleted: false,
    }));

    expect((await request(app, `/api/values/${valueId}`, { method: "DELETE" })).status).toBe(204);
    const deletedKey = encodeURIComponent(`value:${valueId}`);
    history = await (await request(
      app,
      `/api/history?start=2026-08-01&end=2026-08-07&value=${deletedKey}`,
    )).json<typeof history>();
    expect(history.counts).toEqual([
      expect.objectContaining({
        key: `value:${valueId}`,
        id: null,
        name: "Care",
        deleted: true,
      }),
    ]);
    expect(history.actions[0].values[0]).toEqual(expect.objectContaining({
      key: `value:${valueId}`,
      id: null,
      name: "Care",
      deleted: true,
    }));
  });

  it("keeps deleted Values separate when a later Value reuses the same name", async () => {
    const app = createApp(now);
    const firstCareId = await createValue(app, "Care");
    await seedAction({
      id: "first-care-action",
      date: "2026-08-01",
      text: "First Care action",
      status: "done",
      values: [{ id: firstCareId, name: "Care" }],
    });
    await request(app, `/api/values/${firstCareId}`, { method: "DELETE" });

    const secondCareId = await createValue(app, "Care");
    await seedAction({
      id: "second-care-action",
      date: "2026-08-02",
      text: "Second Care action",
      status: "done",
      values: [{ id: secondCareId, name: "Care" }],
    });
    await request(app, `/api/values/${secondCareId}`, { method: "DELETE" });

    const history = await (await request(
      app,
      "/api/history?start=2026-08-01&end=2026-08-07",
    )).json<{
      counts: { key: string; name: string; count: number; deleted: boolean }[];
    }>();
    expect(history.counts).toHaveLength(2);
    expect(history.counts).toEqual(expect.arrayContaining([
      {
        key: `value:${firstCareId}`,
        id: null,
        name: "Care",
        count: 1,
        deleted: true,
      },
      {
        key: `value:${secondCareId}`,
        id: null,
        name: "Care",
        count: 1,
        deleted: true,
      },
    ]));

    for (const [key, actionId] of [
      [`value:${firstCareId}`, "first-care-action"],
      [`value:${secondCareId}`, "second-care-action"],
    ]) {
      const filtered = await (await request(
        app,
        `/api/history?start=2026-08-01&end=2026-08-07&value=${encodeURIComponent(key)}`,
      )).json<{ actions: { id: string }[] }>();
      expect(filtered.actions.map(({ id }) => id)).toEqual([actionId]);
    }
  });

  it("supports the inclusive 7-day, 30-day, and 90-day periods", async () => {
    const app = createApp(now);
    const careId = await createValue(app, "Care");
    for (const [id, date] of [
      ["day-91", "2026-05-09"],
      ["day-90", "2026-05-10"],
      ["day-31", "2026-07-08"],
      ["day-30", "2026-07-09"],
      ["day-8", "2026-07-31"],
      ["day-7", "2026-08-01"],
      ["day-1", "2026-08-07"],
    ]) {
      await seedAction({
        id,
        date,
        text: id,
        status: "done",
        values: [{ id: careId, name: "Care" }],
      });
    }

    async function ids(start: string) {
      const history = await (await request(
        app,
        `/api/history?start=${start}&end=2026-08-07`,
      )).json<{ actions: { id: string }[] }>();
      return history.actions.map(({ id }) => id);
    }

    expect(await ids("2026-08-01")).toEqual(["day-1", "day-7"]);
    expect(await ids("2026-07-09")).toEqual(["day-1", "day-7", "day-8", "day-30"]);
    expect(await ids("2026-05-10")).toEqual([
      "day-1",
      "day-7",
      "day-8",
      "day-30",
      "day-31",
      "day-90",
    ]);
  });

  it("validates ranges and keeps History read-only under the App Time Zone", async () => {
    const currentTime = () => new Date("2026-08-08T23:30:00.000Z");
    const app = createApp(currentTime);
    const careId = await createValue(app, "Care");
    await seedAction({
      id: "past-action",
      date: "2026-08-08",
      text: "Rested",
      status: "done",
      values: [{ id: careId, name: "Care" }],
    });

    expect((await request(
      app,
      "/api/history?start=2026-08-08&end=2026-08-08",
      {},
      "America/Vancouver",
    )).status).toBe(400);
    expect((await request(app, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ appTimeZone: "Europe/Paris" }),
    })).status).toBe(200);
    expect((await request(
      app,
      "/api/history?start=2026-08-08&end=2026-08-08",
      {},
      "Not/AZone",
    )).status).toBe(200);

    for (const path of [
      "/api/history",
      "/api/history?start=nope&end=2026-08-08",
      "/api/history?start=2026-08-08&end=2026-08-07",
      "/api/history?start=2026-08-09&end=2026-08-09",
      "/api/history?start=2026-08-08&end=2026-08-08&value=missing",
    ]) {
      expect((await request(app, path, {}, "Not/AZone")).status).toBe(400);
    }
    for (const method of ["POST", "PATCH", "DELETE"]) {
      expect((await request(app, "/api/history", { method }, "Not/AZone")).status).toBe(404);
    }
    expect((await request(app, "/api/actions/past-action", {
      method: "PATCH",
      body: JSON.stringify({
        text: "Changed the past",
        done: false,
        primaryValueId: careId,
        extraValueIds: [],
      }),
    }, "Not/AZone")).status).toBe(404);
    expect((await request(
      app,
      "/api/actions/past-action",
      { method: "DELETE" },
      "Not/AZone",
    )).status).toBe(404);
  });
});

describe("App Time Zone", () => {
  it("uses the browser Time Zone and reminds the person until one is saved", async () => {
    const app = createApp(() => new Date("2026-08-08T23:30:00.000Z"));

    const todayResponse = await request(
      app,
      "/api/today",
      {},
      "America/Vancouver",
    );
    expect(todayResponse.status).toBe(200);
    expect(await todayResponse.json()).toEqual(
      expect.objectContaining({
        date: "2026-08-08",
        timeZone: {
          appTimeZone: null,
          effectiveTimeZone: "America/Vancouver",
          needsConfirmation: true,
        },
      }),
    );

    expect(await (await request(
      app,
      "/api/settings",
      {},
      "America/Vancouver",
    )).json()).toEqual({
      appTimeZone: null,
      effectiveTimeZone: "America/Vancouver",
      needsConfirmation: true,
    });
  });

  it("saves a valid App Time Zone and uses it before the browser Time Zone", async () => {
    const app = createApp(() => new Date("2026-08-08T23:30:00.000Z"));

    expect((await request(app, "/api/today", {}, "Not/AZone")).status).toBe(400);
    expect((await request(app, "/api/today", {}, "")).status).toBe(400);
    expect((await request(app, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ appTimeZone: "Mars/Olympus" }),
    })).status).toBe(400);

    const savedResponse = await request(app, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ appTimeZone: "Pacific/Auckland" }),
    });
    expect(savedResponse.status).toBe(200);
    expect(await savedResponse.json()).toEqual({
      appTimeZone: "Pacific/Auckland",
      effectiveTimeZone: "Pacific/Auckland",
      needsConfirmation: false,
    });

    const todayResponse = await request(app, "/api/today", {}, "Not/AZone");
    expect(todayResponse.status).toBe(200);
    expect(await todayResponse.json()).toEqual(
      expect.objectContaining({
        date: "2026-08-09",
        timeZone: {
          appTimeZone: "Pacific/Auckland",
          effectiveTimeZone: "Pacific/Auckland",
          needsConfirmation: false,
        },
      }),
    );
  });

  it("keeps past Done actions read-only and lazily removes old Planned actions", async () => {
    let currentTime = new Date("2026-08-08T21:59:00.000Z");
    const app = createApp(() => currentTime);
    await request(app, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ appTimeZone: "Europe/Paris" }),
    });
    const valueId = await createValue(app, "Care");
    const actionPath = `/api/values/${valueId}/actions`;

    const doneResponse = await request(app, actionPath, {
      method: "POST",
      body: JSON.stringify({ text: "Rested", done: true }),
    }, "Pacific/Honolulu");
    const { action: doneAction } = await doneResponse.json<{
      action: { id: string };
    }>();
    const plannedResponse = await request(app, actionPath, {
      method: "POST",
      body: JSON.stringify({ text: "Read later", done: false }),
    }, "Pacific/Honolulu");
    const { action: plannedAction } = await plannedResponse.json<{
      action: { id: string };
    }>();

    currentTime = new Date("2026-08-08T22:01:00.000Z");
    const today = await (await request(
      app,
      "/api/today",
      {},
      "Pacific/Honolulu",
    )).json<{
      date: string;
      values: { actions: unknown[] }[];
    }>();
    expect(today.date).toBe("2026-08-09");
    expect(today.values[0].actions).toEqual([]);

    const stored = await env.DB.prepare(
      "SELECT id, action_date, status FROM daily_actions ORDER BY id",
    ).all<{ id: string; action_date: string; status: string }>();
    expect(stored.results).toEqual([
      { id: doneAction.id, action_date: "2026-08-08", status: "done" },
    ]);

    expect((await request(app, `/api/actions/${doneAction.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        text: "Changed yesterday",
        done: false,
        primaryValueId: valueId,
        extraValueIds: [],
      }),
    }, "Pacific/Honolulu")).status).toBe(404);
    expect((await request(app, `/api/actions/${doneAction.id}`, {
      method: "DELETE",
    }, "Pacific/Honolulu")).status).toBe(404);
    expect((await request(app, `/api/actions/${plannedAction.id}`, {
      method: "DELETE",
    }, "Pacific/Honolulu")).status).toBe(404);

    const newResponse = await request(app, actionPath, {
      method: "POST",
      body: JSON.stringify({
        text: "Today only",
        done: true,
        actionDate: "2026-08-08",
      }),
    }, "Pacific/Honolulu");
    expect(newResponse.status).toBe(201);
    const refreshedToday = await (await request(
      app,
      "/api/today",
      {},
      "Pacific/Honolulu",
    )).json<typeof today>();
    expect(refreshedToday.values[0].actions).toHaveLength(1);
  });
});
