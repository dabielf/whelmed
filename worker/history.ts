type HistoryLinkRow = {
  action_id: string;
  action_date: string;
  text: string;
  value_key: string;
  value_id: string | null;
  value_name: string;
  position: number | null;
};

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
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

export async function readHistory({
  database,
  currentTime,
  timeZone,
  start,
  end,
  selectedValue,
}: {
  database: D1Database;
  currentTime: Date;
  timeZone: string;
  start?: string;
  end?: string;
  selectedValue?: string;
}) {
  const today = dateInTimeZone(currentTime, timeZone);
  if (
    !isIsoDate(start) ||
    !isIsoDate(end) ||
    start > end ||
    end >= today ||
    (selectedValue !== undefined && (!selectedValue.trim() || selectedValue.length > 200))
  ) {
    return { error: "Choose a valid past date range." } as const;
  }

  const { results: rows } = await database.prepare(
    `SELECT da.id AS action_id, da.action_date, da.text,
            dav.value_key, value.id AS value_id,
            COALESCE(value.name, dav.value_name) AS value_name,
            value.position
     FROM daily_actions da
     JOIN daily_action_values dav ON dav.action_id = da.id
     LEFT JOIN app_values value ON value.id = dav.value_id
     WHERE da.status = 'done' AND da.action_date BETWEEN ? AND ?
     ORDER BY da.action_date DESC, da.created_at DESC,
              dav.is_primary DESC, value.position, value_name`,
  ).bind(start, end).all<HistoryLinkRow>();

  const counts = new Map<string, {
    key: string;
    id: string | null;
    name: string;
    count: number;
    deleted: boolean;
    position: number | null;
  }>();
  const actions = new Map<string, {
    id: string;
    date: string;
    text: string;
    values: {
      key: string;
      id: string | null;
      name: string;
      deleted: boolean;
    }[];
  }>();
  for (const row of rows) {
    const count = counts.get(row.value_key) ?? {
      key: row.value_key,
      id: row.value_id,
      name: row.value_name,
      count: 0,
      deleted: row.value_id === null,
      position: row.position,
    };
    count.count += 1;
    counts.set(row.value_key, count);

    const action = actions.get(row.action_id) ?? {
      id: row.action_id,
      date: row.action_date,
      text: row.text,
      values: [],
    };
    action.values.push({
      key: row.value_key,
      id: row.value_id,
      name: row.value_name,
      deleted: row.value_id === null,
    });
    actions.set(row.action_id, action);
  }

  if (selectedValue && !counts.has(selectedValue)) {
    return { error: "Choose a Value from this date range." } as const;
  }

  return {
    start,
    end,
    counts: [...counts.values()]
      .sort((left, right) =>
        Number(left.deleted) - Number(right.deleted) ||
        (left.position ?? Number.MAX_SAFE_INTEGER) -
          (right.position ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name)
      )
      .map(({ position: _position, ...count }) => count),
    actions: [...actions.values()].filter((action) =>
      !selectedValue || action.values.some((value) => value.key === selectedValue)
    ),
  };
}
