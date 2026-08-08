import { Hono, type Context } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

type AppBindings = { Bindings: Env };
type AppContext = Context<AppBindings>;

type ValueRow = {
  id: string;
  name: string;
  meaning: string | null;
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

function timeZoneFrom(context: AppContext) {
  const timeZone = context.req.header("x-time-zone");
  if (!timeZone) return undefined;

  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
    return timeZone;
  } catch {
    return undefined;
  }
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
    const timeZone = timeZoneFrom(context);
    if (!timeZone) {
      return apiError(context, 400, "A valid browser time zone is required.");
    }

    const date = dateInTimeZone(now(), timeZone);
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
      if (String(error).toLowerCase().includes("unique constraint failed")) {
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
    const timeZone = timeZoneFrom(context);
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
    const date = dateInTimeZone(currentTime, timeZone);
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
    const timeZone = timeZoneFrom(context);
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
    const date = dateInTimeZone(currentTime, timeZone);
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
    const timeZone = timeZoneFrom(context);
    if (!timeZone) {
      return apiError(context, 400, "A valid browser time zone is required.");
    }

    const date = dateInTimeZone(now(), timeZone);
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
