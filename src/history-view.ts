export type HistoryValue = {
  key: string;
  id: string | null;
  name: string;
  deleted: boolean;
};

export type HistoryData = {
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

export function historyView(data: HistoryData) {
  const total = data.counts.reduce((sum, count) => sum + count.count, 0);
  // ponytail: History is capped at three months; group once if that range ever becomes slow.
  const days = [...new Set(data.actions.map((action) => action.date))].map((date) => {
    const values = data.counts.flatMap((value) => {
      const actions = data.actions.filter((action) =>
        action.date === date && action.values.some((linked) => linked.key === value.key)
      );
      return actions.length ? [{ ...value, actions }] : [];
    });
    return {
      date,
      values,
      total: values.reduce((sum, value) => sum + value.actions.length, 0),
    };
  });
  return { days, total };
}
