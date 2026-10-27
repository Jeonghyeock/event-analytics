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
// 이벤트가 없는 묶음은 행이 없다(빈 묶음과 아직 오지 않은 묶음은 그래프가 보인다).
export type TableRow = {
  bucket: string;
  label: string;
  note: string | null;
  seriesKey: string;
  series: string;
  events?: number;
  users?: number;
};

// 일부만 찬 묶음의 표시. 앞이 잘린 것은 묶음이 기간 시작보다 앞선 것이다(글자 비교). 앞이 잘리지 않았는데 일부면 뒤가 잘린 것이다.
// 묶음 하나가 앞이 잘렸으면 뒤도 잘렸는지 알 수 없어(날짜 계산을 하지 않는다) 기간 전체를 적는다(코드 리뷰).
function partialNote(q: ReportQuery, b: ChartBucket, i: number, last: number, rangeStart: string): string | null {
  if (!b.partial) return null;
  const frontCut = b.bucket < rangeStart;
  if (frontCut) return i === last ? `일부(${q.from}~${q.to})` : `일부(${q.from}부터)`;
  return `일부(${q.to}까지)`;
}

export function buildTable(q: ReportQuery, result: ReportResult): { rows: TableRow[]; eventsTotal: number | null } {
  const buckets = statesOf(result);
  const byBucket = new Map(buckets.map((b, i) => [b.bucket, { b, i }]));
  const last = buckets.length - 1;
  const rows = result.rows.map((row) => {
    const found = byBucket.get(row.bucket);
    const notes: string[] = [];
    const partial = found ? partialNote(q, found.b, found.i, last, result.meta.rangeStart) : null;
    if (partial) notes.push(partial);
    if (found?.b.state === "current") notes.push("진행 중");
    return {
      bucket: row.bucket,
      label: found?.b.label ?? row.label,
      note: notes.length > 0 ? notes.join(", ") : null,
      seriesKey: seriesKey(q, row.dimensions),
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

// 축의 눈금: 0부터 깔끔한 정수로 4칸쯤(수는 셈이라 소수 눈금이 없다)
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10, 20].map((m) => m * power).find((s) => s >= raw && Number.isInteger(s))!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

// x축 글자(글자 다듬기만, 날짜 계산이 아니다). 글자를 짧게 하고, 겹치지 않을 만큼만 고른다.
// - 기간이 한 해 안이면 연도를 뗀다.
// - 시간 단위: 하루뿐이면 시각만, 여러 날이면 자정(00:00) 묶음에만 날짜를 적는다(같은 간격의 날 경계).
// - 같은 label이 둘인 묶음(두 01:00)은 축에 적지 않는다(툴팁과 표가 오프셋으로 가린다).
export function axisLabels(buckets: readonly ChartBucket[], plotWidth: number): { index: number; text: string }[] {
  const n = buckets.length;
  if (n === 0) return [];
  const sameYear = buckets[0]!.label.slice(0, 4) === buckets[n - 1]!.label.slice(0, 4);
  // 첫 묶음이 두 01:00의 하나면 뒤에 오프셋이 붙으므로 앞부분만 본다
  const hourly = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(buckets[0]!.label);
  const sameDay = buckets.every((b) => b.label.slice(0, 10) === buckets[0]!.label.slice(0, 10));
  const short = (label: string) => {
    if (hourly && sameDay) return label.slice(11);
    if (hourly) return sameYear ? label.slice(5, 10) : label.slice(0, 10);
    return sameYear && /^\d{4}-/.test(label) ? label.slice(5) : label;
  };
  let candidates = buckets.map((b, index) => ({ index, b })).filter(({ b }) => !b.label.includes("("));
  if (hourly && !sameDay) candidates = candidates.filter(({ b }) => b.label.endsWith(" 00:00"));
  if (candidates.length === 0) return [];
  // 글자 너비 + 여백. 이웃한 후보 사이가 그보다 좁으면 건너뛴다. 사이는 가장 좁은 곳으로 잰다: 두 01:00을 뺀 날은 후보 사이가
  // 고르지 않다(첫 두 후보만 재면 3배로 보아 겹친다, 코드 리뷰).
  const labelWidth = Math.max(...candidates.map(({ b }) => textWidth(short(b.label), AXIS_FONT))) + 16;
  const gap = n === 1 ? plotWidth : plotWidth / (n - 1);
  const minIndexGap = Math.min(...candidates.slice(1).map(({ index }, i) => index - candidates[i]!.index));
  const spacing = candidates.length > 1 ? minIndexGap * gap : plotWidth;
  const step = Math.max(1, Math.ceil(labelWidth / spacing));
  return candidates.filter((_, i) => i % step === 0).map(({ index, b }) => ({ index, text: short(b.label) }));
}

// x축 글자 크기(Chart.module.css의 .xTick)
export const AXIS_FONT = 12;

// SVG 글자 너비 어림(px). 재지 않고 글자로 센다: 라틴 글자·숫자는 글자 크기의 0.6배쯤, 한글 등은 1배쯤(넉넉하게).
export function textWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += ch.charCodeAt(0) < 0x80 ? 0.6 : 1;
  return em * fontSize;
}

// 너비를 넘으면 말줄임표로 자른다
export function clipText(text: string, maxWidth: number, fontSize: number): string {
  if (textWidth(text, fontSize) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1 && textWidth(`${chars.join("")}…`, fontSize) > maxWidth) chars.pop();
  return `${chars.join("")}…`;
}
