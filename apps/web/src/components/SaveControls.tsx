import { type SavedReport, SavedReportInput, type SavedReportKind } from "@event-analytics/shared";
import { hashKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { createSavedReport, deleteSavedReport, listSavedReports, updateSavedReport } from "../api/endpoints";
import { type ConfigOf, KIND_LABELS, type OpenedReport, SAVED_KEY, SAVED_PATHS, savedPath } from "../api/saved";
import { issueMessages } from "../lib/issues";
import formStyles from "./Form.module.css";
import styles from "./Saved.module.css";

// 저장하기(DESIGN 6.7). 저장하는 것은 지금 보이는 결과의 설정이다(양식에서 고치고 "보기"를 누르기 전의 것은 아니다).
// - 새것은 POST, 연 것은 "저장"이 PUT(이름을 고쳐 저장하면 이름 바꾸기)이고 "새로 저장"이 POST다.
// - 이름이 겹치면(409) 같은 종류일 때만 덮어쓰기를 권한다(다른 종류를 덮으면 그 리포트가 사라진다).
// - 연 뒤 다른 설정으로 보면 "저장 안 된 변경"을 표시한다.
type SaveVars = { id: string | null; input: SavedReportInput };

export function SaveControls<K extends SavedReportKind>({
  kind,
  opened,
  shown,
}: {
  kind: K;
  opened: OpenedReport<K> | null;
  shown: ConfigOf<K> | null;
}) {
  const id = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(opened?.item.name ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  // 저장한 뒤 새 id로 옮겨 오면(화면이 새로 붙는다) 옮기며 넘긴 알림을 보인다
  const [status, setStatus] = useState<string>(() => (location.state as { saved?: string } | null)?.saved ?? "");
  // 이름이 겹친 같은 종류의 리포트(덮어쓰기 대상)
  const [conflict, setConflict] = useState<SavedReport | null>(null);
  const dirty = opened !== null && shown !== null && hashKey([shown]) !== hashKey([opened.config]);

  const save = useMutation({
    mutationFn: ({ id, input }: SaveVars) => (id === null ? createSavedReport(input) : updateSavedReport(id, input)),
    onSuccess: async ({ item }) => {
      setConflict(null);
      await queryClient.invalidateQueries({ queryKey: SAVED_KEY });
      const message = `"${item.name}"을(를) 저장했습니다.`;
      if (item.id === opened?.item.id) setStatus(message);
      else void navigate(savedPath(kind, item.id), { state: { saved: message } });
    },
    onError: async (error, { id, input }) => {
      if (error instanceof ApiError && error.status === 409) {
        if (id !== null) {
          setErrors(["이 이름은 이미 있습니다. 다른 이름을 고르세요."]);
          return;
        }
        // 이름의 주인을 새 목록에서 찾는다(캐시가 오래됐을 수 있다)
        const list = await queryClient.fetchQuery({ queryKey: SAVED_KEY, queryFn: listSavedReports, staleTime: 0 });
        const owner = list.items.find((i) => i.name === input.name);
        if (owner && owner.kind === kind) {
          setConflict(owner);
          setErrors([`같은 이름의 ${KIND_LABELS[kind]}이(가) 있습니다. 덮어쓰거나 다른 이름을 고르세요.`]);
        } else {
          setErrors([`${owner ? `${KIND_LABELS[owner.kind]} "${owner.name}"` : "다른 리포트"}이(가) 이 이름을 씁니다. 다른 이름을 고르세요.`]);
        }
        return;
      }
      if (error instanceof ApiError && error.status === 404) void queryClient.invalidateQueries({ queryKey: SAVED_KEY });
      setErrors([errorMessage(error)]);
    },
  });

  const submit = (target: string | null) => {
    setStatus("");
    setConflict(null);
    const parsed = SavedReportInput.safeParse({ kind, name, config: shown });
    if (!parsed.success) {
      setErrors(issueMessages(parsed.error.issues));
      return;
    }
    setErrors([]);
    save.mutate({ id: target, input: parsed.data });
  };
  const disabled = shown === null || save.isPending;

  return (
    <form
      className={styles.save}
      aria-label="저장"
      onSubmit={(e) => {
        e.preventDefault();
        submit(opened?.item.id ?? null);
      }}
    >
      <div className={formStyles.row}>
        <label htmlFor={`${id}-name`}>이름</label>
        <input
          id={`${id}-name`}
          value={name}
          maxLength={100}
          onChange={(e) => {
            setName(e.target.value);
            setConflict(null);
          }}
        />
        <button type="submit" className={formStyles.primary} disabled={disabled}>
          저장
        </button>
        {opened && (
          <button type="button" disabled={disabled} onClick={() => submit(null)}>
            새로 저장
          </button>
        )}
        {conflict && (
          <button type="button" disabled={disabled} onClick={() => submit(conflict.id)}>
            덮어쓰기
          </button>
        )}
        {dirty && <span className={styles.dirty}>저장 안 된 변경</span>}
        {opened && <DeleteSaved item={opened.item} />}
      </div>
      {shown === null && <p className={styles.hint}>결과를 본 뒤 저장할 수 있습니다.</p>}
      {errors.length > 0 && (
        <ul className={formStyles.errors} role="alert">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {/* 저장한 뒤 다른 설정으로 보면 "저장했습니다"는 맞지 않는다 */}
      <p className={styles.hint} role="status">
        {dirty ? "" : status}
      </p>
    </form>
  );
}

// 지우기는 두 번 누른다(되돌릴 수 없다). 지우면 그 화면의 새 설정으로 간다.
export function DeleteSaved({ item }: { item: SavedReport }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteSavedReport(item.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SAVED_KEY });
      void navigate(SAVED_PATHS[item.kind]);
    },
    // 이미 없으면(404) 목록만 다시 읽는다
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) void queryClient.invalidateQueries({ queryKey: SAVED_KEY });
    },
  });
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}>
        지우기
      </button>
    );
  }
  return (
    <span className={styles.confirm} role="group" aria-label={`"${item.name}" 지우기`}>
      <span>"{item.name}"을(를) 지울까요?</span>
      <button type="button" className={styles.danger} disabled={remove.isPending} onClick={() => remove.mutate()}>
        정말 지우기
      </button>
      <button type="button" onClick={() => setConfirming(false)}>
        그만두기
      </button>
      {remove.isError && <span role="alert">{errorMessage(remove.error)}</span>}
    </span>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.serverMessage ?? `요청이 실패했습니다(${error.status}).`;
  return "서버에 닿지 않습니다.";
}
