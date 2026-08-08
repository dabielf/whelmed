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

beforeEach(async () => {
  await env.DB.batch([
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
