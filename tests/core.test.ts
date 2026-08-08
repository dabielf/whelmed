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
});
