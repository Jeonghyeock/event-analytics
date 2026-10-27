import type { Metric, ReportQuery, ReportResult } from "@event-analytics/shared";

// 리포트 응답 → 그래프와 표(DESIGN 6.7, 10장 51·53). 화면은 날짜·시간대를 계산하지 않는다.
// 묶음의 순간(bucket, UTC ISO)을 키로 쓰고, 글자는 서버의 label을 쓴다. 순간끼리의 비교는 ISO 글자 비교다(같은 형식이라 차례가 같다).

export const TOP_N = 5;
export const NONE_LABEL = "(없음)";
export const OTHER_LABEL = "기타";
export const OTHER_KEY = "__other__";
export const METRIC_LABELS: Record<Metric, string> = { events: "이벤트 수", users: "사용자 수" };

// done: 다 센 묶음. current: "지금"이 든 묶음(덜 센 값). future: 아직 오지 않은 묶음(그리지 않는다).
export type BucketState = "done" | "current" | "future";

export type ChartBucket = {
  bucket: string;
  // 같은 label이 둘이면(일광 절약 시간이 끝나는 날의 두 01:00) UTC 오프셋을 덧붙인다
  label: string;
  state: BucketState;
  partial: boolean;
};

export type Series = {
  key: string;
  label: string;
  other: boolean;
  // 묶음마다의 값. 아직 오지 않은 묶음은 null(0이 아니다). 사용자 수의 "기타"는 없다(더할 수 없다).
  values: Partial<Record<Metric, (number | null)[]>>;
};

export type ChartData = {
  buckets: ChartBucket[];
  series: Series[];
  // 순위를 매긴 지표. 이벤트 수가 있으면 그것, 없으면 묶음별 사용자 수의 합(고유 사용자 수가 아니다)
  rankedBy: Metric;
  // 그래프에 없는 값의 수. 이벤트 수는 "기타"로 더해 보이므로 사용자 수에만 뜻이 있다.
  hidden: number;
};

// 묶음의 상태. 묶음이 기간 시작보다 앞서면(일부만 찬 첫 주) 기간 시작부터 견준다(미래 기간의 첫 주가 "진행 중"이 되지 않게).
// withRows: 행이 있는 묶음. 수집은 "지금 + 1시간"까지 받으므로 아직 오지 않은 묶음에도 행이 있을 수 있다. 그런 묶음은 진행 중으로 그린다
// (센 이벤트가 그래프에서 빠지지 않게, 코드 리뷰).
export function bucketStates(
  buckets: ReportResult["meta"]["buckets"],
  { asOf, rangeStart, rangeEnd }: Pick<ReportResult["meta"], "asOf" | "rangeStart" | "rangeEnd">,
  withRows: ReadonlySet<string> = new Set(),
): ChartBucket[] {
  const labelCount = new Map<string, number>();
  for (const b of buckets) labelCount.set(b.label, (labelCount.get(b.label) ?? 0) + 1);
  return buckets.map((b, i) => {
    const start = b.bucket > rangeStart ? b.bucket : rangeStart;
    const next = buckets[i + 1]?.bucket ?? rangeEnd;
    const state: BucketState = start > asOf ? (withRows.has(b.bucket) ? "current" : "future") : asOf < next ? "current" : "done";
    const label = labelCount.get(b.label)! > 1 ? `${b.label} (${b.utcOffset})` : b.label;
    return { bucket: b.bucket, label, state, partial: b.partial };
  });
}

const statesOf = (result: ReportResult) => bucketStates(result.meta.buckets, result.meta, new Set(result.rows.map((r) => r.bucket)));

// 계열의 키: 고른 차원 값의 짝. JSON이라 null과 글자 "null", 구분자가 섞이지 않는다.
export const seriesKey = (q: ReportQuery, dimensions: Record<string, string | null>) =>
  JSON.stringify(q.dimensions.map((d) => dimensions[d] ?? null));

export const seriesLabel = (q: ReportQuery, dimensions: Record<string, string | null>) =>
  q.dimensions.length === 0 ? "전체" : q.dimensions.map((d) => dimensions[d] ?? NONE_LABEL).join(" · ");

export function buildChartData(q: ReportQuery, result: ReportResult, topN = TOP_N): ChartData {
  const buckets = statesOf(result);
  const index = new Map(buckets.map((b, i) => [b.bucket, i]));
  // 빈 묶음은 0으로 채운다(그래프가 빈 시간을 건너뛰어 잇지 않게). 아직 오지 않은 묶음은 null이다.
  const empty = (): (number | null)[] => buckets.map((b) => (b.state === "future" ? null : 0));
  const byKey = new Map<string, Series & { totals: Record<Metric, number> }>();
  for (const row of result.rows) {
    const key = seriesKey(q, row.dimensions);
    let s = byKey.get(key);
    if (!s) {
      s = { key, label: seriesLabel(q, row.dimensions), other: false, values: {}, totals: { events: 0, users: 0 } };
      for (const m of q.metrics) s.values[m] = empty();
      byKey.set(key, s);
    }
    const i = index.get(row.bucket);
    if (i === undefined) continue;
    for (const m of q.metrics) {
      const v = row[m] ?? 0;
      const arr = s.values[m]!;
      if (arr[i] !== null) arr[i] = v;
      s.totals[m] += v;
    }
  }
  const rankedBy: Metric = q.metrics.includes("events") ? "events" : "users";
  const ranked = [...byKey.values()].sort((a, b) => b.totals[rankedBy] - a.totals[rankedBy] || (a.key < b.key ? -1 : 1));
  const top = ranked.slice(0, topN);
  const rest = ranked.slice(topN);
  const series: Series[] = top.map(({ key, label, other, values }) => ({ key, label, other, values }));
  if (rest.length > 0 && q.metrics.includes("events")) {
    // 이벤트 수는 나머지를 더한다. 사용자 수는 더하지 않는다(한 사람이 여러 값에 나와 부푼다).
    const events = empty();
    for (const s of rest) s.values.events!.forEach((v, i) => (events[i] = v === null ? null : events[i]! + v));
    series.push({ key: OTHER_KEY, label: OTHER_LABEL, other: true, values: { events } });
  }
  return { buckets, series, rankedBy, hidden: rest.length };
}

// 표의 행: 서버의 행 그대로(묶음 × 계열, 긴 표). 진행 중인 묶음과 일부만 찬 첫·끝 묶음에 표시를 붙인다.
export type TableRow = { bucket: string; label: string; note: string | null; series: string; events?: number; users?: number };

export function buildTable(q: ReportQuery, result: ReportResult): { rows: TableRow[]; eventsTotal: number | null } {
  const buckets = statesOf(result);
  const byBucket = new Map(buckets.map((b, i) => [b.bucket, { b, i }]));
  const last = buckets.length - 1;
  const rows = result.rows.map((row) => {
    const found = byBucket.get(row.bucket);
    const notes: string[] = [];
    if (found?.b.partial && found.i === 0 && q.granularity !== "total") notes.push(`일부(${q.from}부터)`);
    else if (found?.b.partial && found.i === last) notes.push(`일부(${q.to}까지)`);
    if (found?.b.state === "current") notes.push("진행 중");
    return {
      bucket: row.bucket,
      label: found?.b.label ?? row.label,
      note: notes.length > 0 ? notes.join(", ") : null,
      series: seriesLabel(q, row.dimensions),
      ...(row.events !== undefined ? { events: row.events } : {}),
      ...(row.users !== undefined ? { users: row.users } : {}),
    };
  });
  // 합계는 이벤트 수에만 둔다. 사용자 수의 기간 전체는 단위를 "전체"로 다시 묻는다.
  const eventsTotal = q.metrics.includes("events") ? rows.reduce((sum, r) => sum + (r.events ?? 0), 0) : null;
  return { rows, eventsTotal };
}

// 색은 계열을 따라간다(순위가 아니라). 앞에서 받은 칸을 그대로 쓰고, 새 계열은 비어 있는 가장 앞 칸을 받는다.
// 칸은 1~SLOTS(검증한 팔레트의 차례), "기타"는 회색이라 칸이 없다.
export const SLOTS = 5;

export function assignColors(keys: string[], previous: ReadonlyMap<string, number>): Map<string, number> {
  const next = new Map<string, number>();
  for (const key of keys) {
    const slot = previous.get(key);
    if (slot !== undefined) next.set(key, slot);
  }
  for (const key of keys) {
    if (next.has(key) || key === OTHER_KEY) continue;
    const used = new Set(next.values());
    let slot = 1;
    while (used.has(slot) && slot < SLOTS) slot++;
    next.set(key, slot);
  }
  return next;
}

const compact = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("ko-KR");
export const formatCompact = (n: number) => compact.format(n);
export const formatCount = (n: number) => full.format(n);

// 축의 눈금: 0부터 깔끔한 수로 4칸쯤
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}
