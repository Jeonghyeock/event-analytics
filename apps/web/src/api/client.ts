import type { ZodType, z } from "zod";

// 모든 API 요청을 보내는 곳(DESIGN 6.7). 같은 origin이고 Vite가 /api를 떼어 API로 넘긴다.
// - Content-Type은 본문이 있을 때만 붙인다. 본문 없는 요청에 application/json을 붙이면 API가 400이다.
// - 2xx는 그 경로의 응답 스키마로 검사한다. 어긋나면 화면과 API의 계약이 어긋난 것이다(조용히 틀리게 그리지 않는다).
// - 4xx·5xx는 ApiError로 던진다. 리포트의 422·503은 본문에 사람이 읽는 문장(error)과 이유(code)가 있다.

export const API_PREFIX = "/api";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${status} ${path}`);
  }

  get code(): string | undefined {
    if (typeof this.body === "object" && this.body !== null && "code" in this.body) return String(this.body.code);
    return undefined;
  }

  // 본문의 사람이 읽는 문장(API의 error)
  get serverMessage(): string | undefined {
    if (typeof this.body === "object" && this.body !== null && "error" in this.body) return String(this.body.error);
    return undefined;
  }
}

// 응답을 받지 못했다(서버가 꺼짐, 연결 끊김).
export class NetworkError extends Error {
  override name = "NetworkError";
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`network ${path}`);
  }
}

// 2xx인데 응답이 스키마와 다르다. 화면이나 API의 버그다.
export class ContractError extends Error {
  override name = "ContractError";
  constructor(
    readonly path: string,
    readonly issues: unknown,
  ) {
    super(`응답이 계약과 다릅니다: ${path}`);
  }
}

type Options<S extends ZodType> = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  schema: S;
};

export async function apiRequest<S extends ZodType>(path: string, { method = "GET", body, schema }: Options<S>): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new NetworkError(path, err);
  }
  const json = await readJson(res);
  if (!res.ok) throw new ApiError(path, res.status, json);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ContractError(path, parsed.error.issues);
  return parsed.data;
}

// 본문이 없거나 JSON이 아니면(프록시의 502 HTML 등) undefined다.
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
