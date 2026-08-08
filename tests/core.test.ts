import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../worker";

const now = () => new Date("2026-08-08T10:00:00.000Z");

function request(
  app: ReturnType<typeof createApp>,
  path: string,
  options: RequestInit = {},
) {
  const headers = new Headers(options.headers);
  headers.set("x-time-zone", "Europe/Paris");
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

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM daily_action_values"),
    env.DB.prepare("DELETE FROM daily_actions"),
    env.DB.prepare("DELETE FROM app_values"),
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
