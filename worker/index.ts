import { Hono, type Context } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

type AppBindings = { Bindings: Env };
type AppContext = Context<AppBindings>;

type ValueRow = {
  id: string;
  name: string;
  meaning: string | null;
  status: "active" | "paused";
  position: number;
};

type ActionRow = {
  id: string;
  value_id: string;
  value_name: string;
  is_primary: number;
  text: string;
  status: "planned" | "done";
  created_at: string;
};

type LinkedValue = {
  id: string;
  name: string;
};

let cachedIssuer = "";
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function apiError(
  context: AppContext,
  status: 400 | 403 | 404 | 409 | 500,
  message: string,
) {
  return context.json({ error: message }, status);
}

function isLocalRequest(request: Request) {
  const url = new URL(request.url);
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

async function hasAccess(request: Request, env: Env) {
  if (env.LOCAL_DEV === "true" && isLocalRequest(request)) return true;
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return false;

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return false;

  try {
    const issuerUrl = new URL(env.TEAM_DOMAIN);
    if (issuerUrl.protocol !== "https:") return false;

    const issuer = issuerUrl.href.replace(/\/$/, "");
    if (!cachedJwks || cachedIssuer !== issuer) {
      cachedIssuer = issuer;
      cachedJwks = createRemoteJWKSet(
        new URL(`${issuer}/cdn-cgi/access/certs`),
      );
    }

    const { payload } = await jwtVerify(token, cachedJwks, {
      audience: env.POLICY_AUD,
      issuer,
    });
    return typeof payload.email === "string" && payload.email.length > 0;
  } catch {
    return false;
  }
}

function readText(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > maximumLength) return undefined;
  return text;
}

function isUniqueConstraint(error: unknown) {
  return String(error).toLowerCase().includes("unique constraint failed");
}

function readExtraValueIds(value: unknown, primaryValueId: string) {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (id) =>
        typeof id !== "string" ||
        !id ||
        id === primaryValueId,
    ) ||
    new Set(value).size !== value.length
  ) {
    return undefined;
  }
  return value as string[];
}

async function activeValues(database: D1Database, ids: string[]) {
  const { results } = await database
    .prepare(
      `SELECT id, name
       FROM app_values
       WHERE status = 'active' AND id IN (${ids.map(() => "?").join(", ")})`,
    )
    .bind(...ids)
    .all<LinkedValue>();
  return results;
}

function plannedValueCleanup(database: D1Database, valueId: string) {
  return [
    database.prepare(
      `DELETE FROM daily_actions
       WHERE status = 'planned' AND id IN (
         SELECT action_id FROM daily_action_values
         WHERE value_id = ? AND is_primary = 1
       )`,
    ).bind(valueId),
    database.prepare(
      `DELETE FROM daily_action_values
       WHERE value_id = ? AND is_primary = 0 AND action_id IN (
         SELECT id FROM daily_actions WHERE status = 'planned'
       )`,
    ).bind(valueId),
  ];
}

async function readObject(context: AppContext) {
  try {
    const body: unknown = await context.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readTimeZone(value: unknown) {
  const timeZone = readText(value, 100);
  if (!timeZone) return undefined;

  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
    return timeZone;
  } catch {
    return undefined;
  }
}

async function timeZoneState(context: AppContext) {
  const setting = await context.env.DB.prepare(
    "SELECT app_time_zone FROM settings WHERE id = 1",
  ).first<{ app_time_zone: string | null }>();
  const appTimeZone = setting?.app_time_zone ?? null;
  const effectiveTimeZone =
    appTimeZone ?? readTimeZone(context.req.header("x-time-zone"));
  if (!effectiveTimeZone) return undefined;

  return {
    appTimeZone,
    effectiveTimeZone,
    needsConfirmation: appTimeZone === null,
  };
}

function dateInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en", {
    calendar: "iso8601",
    day: "2-digit",
    month: "2-digit",
    numberingSystem: "latn",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;

  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function createApp(now: () => Date = () => new Date()) {
  const app = new Hono<AppBindings>();

  app.use("/api/*", async (context, next) => {
    if (!(await hasAccess(context.req.raw, context.env))) {
      return apiError(context, 403, "Access denied.");
    }
    await next();
  });

  app.get("/api/today", async (context) => {
    const timeZone = await timeZoneState(context);
    if (!timeZone) {
      return apiError(context, 400, "A valid browser time zone is required.");
    }

    const date = dateInTimeZone(now(), timeZone.effectiveTimeZone);
    await context.env.DB.prepare(
      "DELETE FROM daily_actions WHERE status = 'planned' AND action_date < ?",
    )
      .bind(date)
      .run();
    const [{ results: values }, { results: actions }] = await Promise.all([
      context.env.DB.prepare(
        `SELECT id, name, meaning, position
         FROM app_values
         WHERE status = 'active'
         ORDER BY position, created_at`,
      ).all<ValueRow>(),
      context.env.DB.prepare(
        `SELECT da.id, dav.value_id, value.name AS value_name,
                dav.is_primary, da.text, da.status, da.created_at
         FROM daily_actions da
         JOIN daily_action_values dav ON dav.action_id = da.id
         JOIN app_values value
           ON value.id = dav.value_id AND value.status = 'active'
         WHERE da.action_date = ?
           AND EXISTS (
             SELECT 1
             FROM daily_action_values primary_link
             JOIN app_values primary_value
               ON primary_value.id = primary_link.value_id
              AND primary_value.status = 'active'
             WHERE primary_link.action_id = da.id
               AND primary_link.is_primary = 1
           )
         ORDER BY da.created_at, dav.is_primary DESC, value.position`,
      )
        .bind(date)
        .all<ActionRow>(),
    ]);

    const groupedActions = new Map<
      string,
      Omit<ActionRow, "value_id" | "value_name" | "is_primary"> & {
        values: { id: string; name: string; isPrimary: boolean }[];
      }
    >();
    for (const action of actions) {
      const existing = groupedActions.get(action.id);
      if (existing) {
        existing.values.push({
          id: action.value_id,
          name: action.value_name,
          isPrimary: action.is_primary === 1,
        });
      } else {
        const { value_id, value_name, is_primary, ...details } = action;
        groupedActions.set(action.id, {
          ...details,
          values: [
            {
              id: value_id,
              name: value_name,
              isPrimary: is_primary === 1,
            },
          ],
        });
      }
    }

    return context.json({
      date,
      timeZone,
      values: values.map((value) => ({
        ...value,
        actions: [...groupedActions.values()].filter((action) =>
          action.values.some(
            (linkedValue) =>
              linkedValue.isPrimary && linkedValue.id === value.id,
          ),
        ),
      })),
    });
  });

  app.get("/api/settings", async (context) => {
    const timeZone = await timeZoneState(context);
    if (!timeZone) {
      return apiError(context, 400, "A valid browser time zone is required.");
    }
    return context.json(timeZone);
  });

  app.patch("/api/settings", async (context) => {
    const body = await readObject(context);
    const appTimeZone = readTimeZone(body?.appTimeZone);
    if (!appTimeZone) {
      return apiError(context, 400, "Choose a valid IANA Time Zone.");
    }

    await context.env.DB.prepare(
      "UPDATE settings SET app_time_zone = ?, updated_at = ? WHERE id = 1",
    )
      .bind(appTimeZone, now().toISOString())
      .run();
    return context.json({
      appTimeZone,
      effectiveTimeZone: appTimeZone,
      needsConfirmation: false,
    });
  });

  app.get("/api/values", async (context) => {
    const { results } = await context.env.DB.prepare(
      `SELECT id, name, meaning, status, position
       FROM app_values
       ORDER BY position, created_at`,
    ).all<ValueRow>();
    return context.json({ values: results });
  });

  app.put("/api/values/order", async (context) => {
    const body = await readObject(context);
    const ids = body?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length > 1_000 ||
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    ) {
      return apiError(context, 400, "Send every Value once.");
    }

    const { results: stored } = await context.env.DB.prepare(
      "SELECT id FROM app_values",
    ).all<{ id: string }>();
    const storedIds = new Set(stored.map(({ id }) => id));
    if (ids.length !== stored.length || ids.some((id) => !storedIds.has(id))) {
      return apiError(context, 400, "Send every Value once.");
    }

    if (ids.length) {
      const timestamp = now().toISOString();
      await context.env.DB.batch(
        ids.map((id, position) =>
          context.env.DB.prepare(
            "UPDATE app_values SET position = ?, updated_at = ? WHERE id = ?",
          ).bind(position, timestamp, id),
        ),
      );
    }

    const { results: values } = await context.env.DB.prepare(
      `SELECT id, name, meaning, status, position
       FROM app_values
       ORDER BY position, created_at`,
    ).all<ValueRow>();
    return context.json({ values });
  });

  app.patch("/api/values/:valueId", async (context) => {
    const body = await readObject(context);
    if (
      !body ||
      (body.name === undefined &&
        body.meaning === undefined &&
        body.status === undefined)
    ) {
      return apiError(context, 400, "Choose a Value change.");
    }
    const valueId = context.req.param("valueId");
    const current = await context.env.DB.prepare(
      "SELECT id, name, meaning, status, position FROM app_values WHERE id = ?",
    )
      .bind(valueId)
      .first<ValueRow>();
    if (!current) return apiError(context, 404, "Value not found.");

    const name = body?.name === undefined ? current.name : readText(body.name, 80);
    if (!name) {
      return apiError(context, 400, "Use a Value name from 1 to 80 characters.");
    }

    let meaning = current.meaning;
    if (body?.meaning !== undefined) {
      if (typeof body.meaning !== "string" || body.meaning.trim().length > 500) {
        return apiError(
          context,
          400,
          "Personal meaning must be 500 characters or fewer.",
        );
      }
      meaning = body.meaning.trim() || null;
    }

    const status = body?.status === undefined ? current.status : body.status;
    if (status !== "active" && status !== "paused") {
      return apiError(context, 400, "Choose Active or Paused.");
    }

    try {
      const statements = [
        context.env.DB.prepare(
          `UPDATE app_values
           SET name = ?, meaning = ?, status = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(name, meaning, status, now().toISOString(), valueId),
        context.env.DB.prepare(
          "UPDATE daily_action_values SET value_name = ? WHERE value_id = ?",
        ).bind(name, valueId),
      ];
      if (status === "paused") {
        statements.push(...plannedValueCleanup(context.env.DB, valueId));
      }
      await context.env.DB.batch(statements);
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return apiError(context, 409, "That Value already exists.");
      }
      throw error;
    }

    const value = await context.env.DB.prepare(
      "SELECT id, name, meaning, status, position FROM app_values WHERE id = ?",
    )
      .bind(valueId)
      .first<ValueRow>();
    return context.json({ value });
  });

  app.delete("/api/values/:valueId", async (context) => {
    const valueId = context.req.param("valueId");
    const value = await context.env.DB.prepare(
      "SELECT id FROM app_values WHERE id = ?",
    )
      .bind(valueId)
      .first<{ id: string }>();
    if (!value) return apiError(context, 404, "Value not found.");

    await context.env.DB.batch([
      ...plannedValueCleanup(context.env.DB, valueId),
      context.env.DB.prepare("DELETE FROM app_values WHERE id = ?").bind(valueId),
    ]);
    return context.body(null, 204);
  });

  app.post("/api/values", async (context) => {
    const body = await readObject(context);
    const name = readText(body?.name, 80);
    if (!name) {
      return apiError(context, 400, "Use a Value name from 1 to 80 characters.");
    }

    let meaning: string | null = null;
    if (body?.meaning !== undefined) {
      if (typeof body.meaning !== "string") {
        return apiError(
          context,
          400,
          "Personal meaning must be 500 characters or fewer.",
        );
      }
      const trimmedMeaning = body.meaning.trim();
      if (trimmedMeaning.length > 500) {
        return apiError(
          context,
          400,
          "Personal meaning must be 500 characters or fewer.",
        );
      }
      meaning = trimmedMeaning || null;
    }

    const id = crypto.randomUUID();
    const timestamp = now().toISOString();

    try {
      await context.env.DB.prepare(
        `INSERT INTO app_values
           (id, name, meaning, status, position, created_at, updated_at)
         VALUES (?, ?, ?, 'active',
           (SELECT COALESCE(MAX(position), -1) + 1 FROM app_values), ?, ?)`,
      )
        .bind(id, name, meaning, timestamp, timestamp)
        .run();
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return apiError(context, 409, "That Value already exists.");
      }
      throw error;
    }

    return context.json(
      { value: { id, name, meaning, position: null, status: "active" } },
      201,
    );
  });

  app.post("/api/values/:valueId/actions", async (context) => {
    const timeZone = await timeZoneState(context);
    if (!timeZone) {
      return apiError(context, 400, "A valid browser time zone is required.");
    }

    const body = await readObject(context);
    const text = readText(body?.text, 500);
    if (!text) {
      return apiError(context, 400, "Use action text from 1 to 500 characters.");
    }
    if (typeof body?.done !== "boolean") {
      return apiError(context, 400, "Done must be on or off.");
    }

    const primaryValueId = context.req.param("valueId");
    const extraValueIds = readExtraValueIds(
      body?.extraValueIds === undefined ? [] : body.extraValueIds,
      primaryValueId,
    );
    if (!extraValueIds) {
      return apiError(context, 400, "Choose each extra Value only once.");
    }

    const linkedValues = await activeValues(context.env.DB, [
      primaryValueId,
      ...extraValueIds,
    ]);
    if (linkedValues.length !== extraValueIds.length + 1) {
      return apiError(context, 400, "Choose Active Values only.");
    }
    const value = linkedValues.find(({ id }) => id === primaryValueId)!;

    const id = crypto.randomUUID();
    const currentTime = now();
    const timestamp = currentTime.toISOString();
    const date = dateInTimeZone(currentTime, timeZone.effectiveTimeZone);
    const status = body.done ? "done" : "planned";

    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO daily_actions
           (id, action_date, text, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(id, date, text, status, timestamp, timestamp),
      context.env.DB.prepare(
        `INSERT INTO daily_action_values
           (id, action_id, value_id, value_name, is_primary)
         VALUES (?, ?, ?, ?, 1)`,
      ).bind(crypto.randomUUID(), id, value.id, value.name),
      ...extraValueIds.map((extraValueId) => {
        const extraValue = linkedValues.find(({ id }) => id === extraValueId)!;
        return context.env.DB.prepare(
          `INSERT INTO daily_action_values
             (id, action_id, value_id, value_name, is_primary)
           VALUES (?, ?, ?, ?, 0)`,
        ).bind(
          crypto.randomUUID(),
          id,
          extraValue.id,
          extraValue.name,
        );
      }),
    ]);

    return context.json(
      {
        action: {
          id,
          text,
          status,
          created_at: timestamp,
          values: linkedValues.map((linkedValue) => ({
            ...linkedValue,
            isPrimary: linkedValue.id === primaryValueId,
          })),
        },
      },
      201,
    );
  });

  app.patch("/api/actions/:actionId", async (context) => {
    const timeZone = await timeZoneState(context);
    if (!timeZone) {
      return apiError(context, 400, "A valid browser time zone is required.");
    }

    const body = await readObject(context);
    const text = readText(body?.text, 500);
    if (!text) {
      return apiError(context, 400, "Use action text from 1 to 500 characters.");
    }
    if (typeof body?.done !== "boolean") {
      return apiError(context, 400, "Done must be on or off.");
    }
    const primaryValueId = readText(body?.primaryValueId, 100);
    if (!primaryValueId) {
      return apiError(context, 400, "Choose one primary Value.");
    }
    const extraValueIds = readExtraValueIds(
      body?.extraValueIds,
      primaryValueId,
    );
    if (!extraValueIds) {
      return apiError(context, 400, "Choose each extra Value only once.");
    }

    const currentTime = now();
    const date = dateInTimeZone(currentTime, timeZone.effectiveTimeZone);
    const actionId = context.req.param("actionId");
    const action = await context.env.DB.prepare(
      `SELECT id FROM daily_actions WHERE id = ? AND action_date = ?`,
    )
      .bind(actionId, date)
      .first<{ id: string }>();
    if (!action) return apiError(context, 404, "Today's action not found.");

    const linkedValues = await activeValues(context.env.DB, [
      primaryValueId,
      ...extraValueIds,
    ]);
    if (linkedValues.length !== extraValueIds.length + 1) {
      return apiError(context, 400, "Choose Active Values only.");
    }

    const timestamp = currentTime.toISOString();
    const status = body.done ? "done" : "planned";
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE daily_actions
         SET text = ?, status = ?, updated_at = ?
         WHERE id = ? AND action_date = ?`,
      ).bind(text, status, timestamp, actionId, date),
      context.env.DB.prepare(
        `DELETE FROM daily_action_values WHERE action_id = ?`,
      ).bind(actionId),
      ...[primaryValueId, ...extraValueIds].map((valueId) => {
        const linkedValue = linkedValues.find(({ id }) => id === valueId)!;
        return context.env.DB.prepare(
          `INSERT INTO daily_action_values
             (id, action_id, value_id, value_name, is_primary)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          actionId,
          linkedValue.id,
          linkedValue.name,
          linkedValue.id === primaryValueId ? 1 : 0,
        );
      }),
    ]);

    return context.json({ action: { id: actionId, text, status } });
  });

  app.delete("/api/actions/:actionId", async (context) => {
    const timeZone = await timeZoneState(context);
    if (!timeZone) {
      return apiError(context, 400, "A valid browser time zone is required.");
    }

    const date = dateInTimeZone(now(), timeZone.effectiveTimeZone);
    const result = await context.env.DB.prepare(
      `DELETE FROM daily_actions WHERE id = ? AND action_date = ?`,
    )
      .bind(context.req.param("actionId"), date)
      .run();
    if (!result.meta.changes) {
      return apiError(context, 404, "Today's action not found.");
    }
    return context.body(null, 204);
  });

  app.notFound((context) => apiError(context, 404, "Not found."));
  app.onError((error, context) => {
    console.error(error);
    return apiError(context, 500, "Something went wrong.");
  });

  return app;
}

export default createApp();
