export type HistoryPreset = 7 | 30 | "3months";

export function shiftDate(date: string, days: number) {
  const shifted = new Date(`${date}T12:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function shiftMonths(date: string, months: number) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return shifted.toISOString().slice(0, 10);
}

export function historyRange(today: string, preset: HistoryPreset) {
  const end = shiftDate(today, -1);
  const start = preset === "3months"
    ? shiftMonths(today, -3)
    : shiftDate(end, 1 - preset);
  return { start, end };
}
