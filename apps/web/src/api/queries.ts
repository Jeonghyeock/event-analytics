import { QueryClient } from "@tanstack/react-query";
import { NetworkError } from "./client";

// 서버 상태는 TanStack Query 캐시에만 둔다. 리포트는 비싼 질의라 창으로 돌아올 때 다시 묻지 않는다.
// 다시 묻기는 연결이 끊겼을 때 한 번뿐이다. 422(설정을 고쳐야 함)·503(서버가 바쁨)은 화면이 알리고 사람이 다시 한다.
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => error instanceof NetworkError && failureCount < 1,
      },
    },
  });
}
