import { type SavedReport, SavedReportInput, type SavedReportKind } from "@event-analytics/shared";
import { hashKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { createSavedReport, deleteSavedReport, listSavedReports, updateSavedReport } from "../api/endpoints";
import { type ConfigOf, KIND_LABELS, KIND_SUBJECTS, type OpenedReport, SAVED_KEY, SAVED_PATHS, savedPath, useSavedNotice } from "../api/saved";
import { issueMessages } from "../lib/issues";
import formStyles from "./Form.module.css";
import styles from "./Saved.module.css";
import { errorText } from "./States";

// 저장하기(DESIGN 6.7). 저장하는 것은 지금 보이는 결과의 설정이다(양식에서 고치고 "보기"를 누르기 전의 것은 아니다).
// - 새것은 POST, 연 것은 "저장"이 PUT(이름을 고쳐 저장하면 이름 바꾸기)이고 "다른 이름으로 저장"이 POST다.
// - 이름이 겹치면(409) 같은 종류의 다른 리포트일 때만 덮어쓰기를 권한다(다른 종류를 덮으면 그 리포트가 사라진다).
// - 연 뒤 다른 설정으로 보면(세는 중이어도) "저장 안 된 변경"을 표시한다.
// - 저장·지우기가 끝난 뒤의 이동은 그 요청을 낸 화면이 아직 있을 때만 한다(기다리는 사이 다른 것을 열었으면 빼앗지 않는다).
type SaveVars = { id: string | null; input: SavedReportInput };

export function SaveControls<K extends SavedReportKind>({
  kind,
  opened,
  requested,
  shown,
}: {
  kind: K;
  opened: OpenedReport<K> | null;
  // requested: 마지막으로 "보기"를 누른 설정. shown: 그 설정을 다 센 결과가 보일 때 그 설정(세는 중·실패면 null)
  requested: ConfigOf<K> | null;
  shown: ConfigOf<K> | null;
}) {
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notice, notify } = useSavedNotice();
  const [name, setName] = useState(opened?.item.name ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  // 이름이 겹친 같은 종류의 다른 리포트(덮어쓰기 대상)
  const [conflict, setConflict] = useState<SavedReport | null>(null);
  const dirty = opened !== null && requested !== null && hashKey([requested]) !== hashKey([opened.config]);
  const ready = shown !== null;

  const save = useMutation({
    mutationFn: ({ id, input }: SaveVars) => (id === null ? createSavedReport(input) : updateSavedReport(id, input)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SAVED_KEY }),
  });

  const submit = (target: string | null) => {
    setConflict(null);
    const parsed = SavedReportInput.safeParse({ kind, name, config: shown });
    if (!parsed.success) {
      setErrors(issueMessages(parsed.error.issues));
      return;
    }
    setErrors([]);
    const input = parsed.data;
    save.mutate(
      { id: target, input },
      {
        onSuccess: ({ item }) => {
          const text = `"${item.name}"을(를) 저장했습니다.`;
          if (item.id === opened?.item.id) {
            notify({ for: item.id, text });
            return;
          }
          // 새 id의 화면으로 옮긴다(뒤로 가기가 저장 전의 빈 화면으로 가지 않게 바꿔 넣는다)
          notify({ for: item.id, text }, { focus: true });
          void navigate(savedPath(kind, item.id), { replace: true });
        },
        onError: async (error) => {
          if (error instanceof ApiError && error.status === 409) {
            if (target !== null) {
              setErrors(["이 이름은 이미 있습니다. 다른 이름을 고르세요."]);
              return;
            }
            // 이름의 주인을 새 목록에서 찾는다(캐시가 오래됐을 수 있다)
            const list = await queryClient.fetchQuery({ queryKey: SAVED_KEY, queryFn: listSavedReports, staleTime: 0 });
            const owner = list.items.find((i) => i.name === input.name);
            if (owner && owner.id === opened?.item.id) {
              setErrors(["지금 연 리포트의 이름입니다. 다른 이름을 쓰세요."]);
            } else if (owner && owner.kind === kind) {
              setConflict(owner);
              setErrors([`같은 이름의 ${KIND_SUBJECTS[kind]} 있습니다. 덮어쓰거나 다른 이름을 고르세요.`]);
            } else {
              setErrors([
                owner ? `이 이름은 ${KIND_LABELS[owner.kind]} "${owner.name}"에서 쓰고 있습니다. 다른 이름을 고르세요.` : "이 이름은 이미 있습니다. 다른 이름을 고르세요.",
              ]);
            }
            return;
          }
          // 연 것이 그 사이 지워졌다: 보던 설정과 결과는 그대로 두고 새로 저장하게 한다(목록을 다시 읽으면 화면이 새로 붙어 사라진다)
          if (error instanceof ApiError && error.status === 404) {
            setErrors(['이 리포트는 그 사이 지워졌습니다. "다른 이름으로 저장"으로 새로 저장할 수 있습니다.']);
            return;
          }
          setErrors([errorText(error)]);
        },
      },
    );
  };
  const disabled = !ready || save.isPending;

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
        <label htmlFor={`${id}-name`}>저장할 이름</label>
        <input
          id={`${id}-name`}
          value={name}
          maxLength={100}
          onChange={(e) => {
            setName(e.target.value);
            setConflict(null);
          }}
        />
        <button type="submit" className={formStyles.primary} disabled={disabled} aria-describedby={ready ? undefined : `${id}-why`}>
          저장
        </button>
        {opened && (
          <button type="button" disabled={disabled} onClick={() => submit(null)}>
            다른 이름으로 저장
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
      {!ready && (
        <p className={styles.hint} id={`${id}-why`}>
          결과가 나온 뒤 저장할 수 있습니다.
        </p>
      )}
      {errors.length > 0 && (
        <ul className={formStyles.errors} role="alert">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {/* 알림 글(읽어 주는 것은 SavedGate의 자리). 저장한 뒤 다른 설정으로 보면 맞지 않으므로 감춘다. */}
      {notice && !dirty && <p className={styles.hint}>{notice.text}</p>}
    </form>
  );
}

// 지우기는 두 번 누른다(되돌릴 수 없다). 지우면 그 화면의 새 설정으로 간다. 이미 지워졌으면(404) 지운 것으로 본다.
export function DeleteSaved({ item }: { item: SavedReport }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useSavedNotice();
  const [confirming, setConfirming] = useState(false);
  // 확인 묶음이 열리면 "그만두기"로(덜 위험한 쪽), 그만두면 "지우기"로 포커스를 옮긴다(누른 단추가 사라지므로)
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    (confirming ? cancelButton : deleteButton).current?.focus();
  }, [confirming]);
  const toggle = (next: boolean) => {
    toggled.current = true;
    setConfirming(next);
  };
  const remove = useMutation({
    mutationFn: async () => {
      try {
        await deleteSavedReport(item.id);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SAVED_KEY }),
  });
  const confirm = () =>
    remove.mutate(undefined, {
      onSuccess: () => {
        notify({ for: null, text: `"${item.name}"을(를) 지웠습니다.` }, { focus: true });
        // 지운 것의 주소로 뒤로 가지 않게 바꿔 넣는다
        void navigate(SAVED_PATHS[item.kind], { replace: true });
      },
    });

  if (!confirming) {
    return (
      <button type="button" ref={deleteButton} onClick={() => toggle(true)}>
        지우기
      </button>
    );
  }
  return (
    <span className={styles.confirm} role="group" aria-label={`"${item.name}" 지우기`}>
      <span>"{item.name}"을(를) 지울까요?</span>
      <button type="button" className={styles.danger} disabled={remove.isPending} onClick={confirm}>
        정말 지우기
      </button>
      <button type="button" ref={cancelButton} onClick={() => toggle(false)}>
        그만두기
      </button>
      {remove.isError && <span role="alert">{errorText(remove.error)}</span>}
    </span>
  );
}
