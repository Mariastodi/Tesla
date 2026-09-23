import { useEffect, useState } from "react";
import { api } from "./api";

const GOOGLE_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/18dbQrczPuRkr3CG5mTHduJ159YJFGFMv_QLAcuAraf4/edit";

const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
  }).format(new Date());

const hours = (n) =>
  n == null
    ? "—"
    : `${Math.floor(Math.abs(n) / 60)}h${String(
        Math.abs(n) % 60,
      ).padStart(2, "0")}`;

export function TeacherAttendancePanel({ data, pin, onConfig }) {
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());

  const [report, setReport] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const [settings, setSettings] = useState(null);

  const [date, setDate] = useState(today());
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState("");
  const [teacherId, setTeacherId] = useState("");

  const headers = { "x-admin-pin": pin };

  async function load() {
    const result = await api(
      `/api/admin/teacher-attendance?from=${from}&to=${to}`,
      { headers },
    );

    setReport(result);

    setSettings(
      (previous) =>
        previous || {
          ...result.settings,
          successScreenMs:
            data.config.successScreenMs || 5500,
        },
    );
  }

  useEffect(() => {
    load().catch((e) => setMessage(e.message));
  }, [from, to]);

  useEffect(() => {
    let active = true;

    setSessionId("");

    api(`/api/admin/teacher-sessions?date=${date}`, {
      headers,
    })
      .then((r) => {
        if (active) {
          setSessions(r.sessions);
        }
      })
      .catch((e) => {
        if (active) {
          setMessage(e.message);
        }
      });

    return () => {
      active = false;
    };
  }, [date]);

  async function perform(action) {
    if (busy) return;

    setBusy(true);
    setMessage("");

    try {
      await action();
      await load();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    const response = await fetch(
      `/api/admin/teacher-attendance.xlsx?from=${from}&to=${to}`,
      {
        headers,
        signal: AbortSignal.timeout(60000),
      },
    );

    if (!response.ok) {
      throw new Error("Não foi possível baixar o XLSX.");
    }

    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement("a");

    a.href = url;
    a.download = `ponto-tesla-${from}-${to}.xlsx`;
    a.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <>
      <section className="panel">
        <h2>Ponto dos professores</h2>

        <div className="form-grid">
          <label className="field">
            De
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>

          <label className="field">
            Até
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>

        <div className="point-actions">
          <button
            className="text-button"
            disabled={busy}
            onClick={() => perform(load)}
          >
            Atualizar
          </button>

          <button
            className="primary"
            disabled={busy}
            onClick={() => perform(download)}
          >
            Baixar XLSX
          </button>

          <a
            href={GOOGLE_SHEET_URL}
            target="_blank"
            rel="noreferrer"
          >
            Abrir Google Planilhas ↗
          </a>
        </div>

        <p className="field-hint">
          {report?.sync.configured
            ? report.sync.lastError ||
              (report.sync.pending
                ? "Registros salvos. Sincronização pendente."
                : "Planilha sincronizada.")
            : "Google Planilhas ainda não conectado. Todos os pontos são salvos no banco e podem ser baixados em XLSX."}
        </p>

        {report?.sync.lastSyncedAt && (
          <p className="field-hint">
            Última sincronização:{" "}
            {new Date(report.sync.lastSyncedAt).toLocaleString(
              "pt-BR",
              {
                timeZone: "America/Fortaleza",
              },
            )}
          </p>
        )}

        {report?.sync.configured && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              perform(async () => {
                const r = await api(
                  "/api/admin/teacher-sync",
                  {
                    method: "POST",
                    headers,
                    body: "{}",
                  },
                );

                setMessage(
                  r.state === "synced"
                    ? "Planilha atualizada."
                    : "Nova tentativa será feita automaticamente.",
                );
              })
            }
          >
            Sincronizar agora
          </button>
        )}

        <p role="status" className="settings-message">
          {message}
        </p>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  "Data",
                  "Professor previsto",
                  "Professor realizado / designado",
                  "Turma",
                  "Previsto",
                  "Entrada",
                  "Saída",
                  "Realizado",
                  "Diferença",
                  "Tipo / Estado",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>

            <tbody>
              {report?.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.data.split("-").reverse().join("/")}
                  </td>

                  <td>{r.professorPrevistoNome}</td>

                  <td>{r.professorNome}</td>

                  <td>{r.turmaNome}</td>

                  <td>
                    {r.horarioInicioPrevisto}–
                    {r.horarioFimPrevisto}
                  </td>

                  <td>{r.entradaHora || "—"}</td>

                  <td>{r.saidaHora || "—"}</td>

                  <td>{hours(r.minutosRealizados)}</td>

                  <td>
                    {r.diferencaMinutos == null
                      ? "—"
                      : `${
                          r.diferencaMinutos > 0 ? "+" : ""
                        }${r.diferencaMinutos} min`}
                  </td>

                  <td>
                    {r.tipoProfessor} · {r.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {report && !report.rows.length && (
          <p>Nenhum ponto neste período.</p>
        )}

        <p className="field-hint">
          “Sem registro” indica ausência de ponto, não confirmação
          de falta. Horas e diferenças são informativas, sem cálculo
          salarial.
        </p>
      </section>

      <section className="panel">
        <h2>Resumo do período</h2>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  "Professor",
                  "Previstas",
                  "Concluídas",
                  "Diferença concluídas",
                  "Aulas",
                  "Substituições",
                  "Sem registro",
                  "Saída pendente",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>

            <tbody>
              {report?.summary.map((s) => (
                <tr key={s.professor}>
                  <td>{s.professor}</td>
                  <td>{hours(s.previstos)}</td>
                  <td>{hours(s.realizados)}</td>
                  <td>{s.diferenca} min</td>
                  <td>{s.aulas}</td>
                  <td>{s.substituicoes}</td>
                  <td>{s.semRegistro}</td>
                  <td>{s.pendentes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Agendar professor substituto</h2>

        <p>
          Vale somente para a aula escolhida. O titular da turma é
          preservado.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();

            perform(async () => {
              await api(
                "/api/admin/teacher-substitutions",
                {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    date,
                    sessionId,
                    professorId: teacherId,
                  }),
                },
              );

              setMessage("Substituição salva.");
            });
          }}
        >
          <div className="form-grid">
            <label className="field">
              Data
              <input
                type="date"
                min={today()}
                value={date}
                required
                onChange={(e) => setDate(e.target.value)}
              />
            </label>

            <label className="field">
              Aula
              <select
                value={sessionId}
                required
                onChange={(e) => setSessionId(e.target.value)}
              >
                <option value="">Selecione a aula</option>

                {sessions.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.turmaNome} · {s.inicio}–{s.fim} ·{" "}
                    {s.professor}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              Substituto
              <select
                value={teacherId}
                required
                onChange={(e) => setTeacherId(e.target.value)}
              >
                <option value="">
                  Selecione o professor
                </option>

                {data.professores
                  .filter(
                    (t) =>
                      t.ativo !== false &&
                      t.cpfStatus === "verificado",
                  )
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nome}
                    </option>
                  ))}
              </select>
            </label>
          </div>

          <p className="field-hint">
            Cadastre o CPF em Professores → Editar para habilitar o
            ponto.
          </p>

          <button
            className="primary"
            disabled={busy}
          >
            Salvar substituição
          </button>
        </form>

        {report?.substitutions
          .filter((s) => s.data >= today())
          .map((s) => (
            <div
              className="substitution-row"
              key={s.id}
            >
              <span>
                {s.data} · {s.turmaNome} · {s.inicio}–
                {s.fim}
                <br />
                {s.professorPrevistoNome} →{" "}
                {s.professorNome}
              </span>

              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    await api(
                      `/api/admin/teacher-substitutions/${encodeURIComponent(
                        s.id,
                      )}`,
                      {
                        method: "DELETE",
                        headers,
                        body: "{}",
                      },
                    );

                    setMessage(
                      "Substituição cancelada.",
                    );
                  })
                }
              >
                Cancelar substituição
              </button>
            </div>
          ))}
      </section>

      {settings && (
        <section className="panel">
          <h2>Regras do ponto</h2>

          <form
            onSubmit={(e) => {
              e.preventDefault();

              perform(async () => {
                const r = await api(
                  "/api/admin/teacher-settings",
                  {
                    method: "PUT",
                    headers,
                    body: JSON.stringify(settings),
                  },
                );

                onConfig(r.config);
                setMessage("Regras salvas.");
              });
            }}
          >
            <div className="form-grid">
              {Object.entries({
                entryBefore:
                  "Entrada: minutos antes do início",
                exitBefore:
                  "Saída: minutos antes do fim",
                exitAfter:
                  "Saída: minutos após o fim",
                duplicateMinutes:
                  "Intervalo mínimo entre entrada e saída",
              }).map(([key, label]) => (
                <label className="field" key={key}>
                  {label}

                  <input
                    type="number"
                    min={
                      key === "duplicateMinutes"
                        ? 1
                        : 0
                    }
                    max="240"
                    value={settings[key]}
                    required
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        [key]: Number(
                          e.target.value,
                        ),
                      })
                    }
                  />
                </label>
              ))}

              <label className="field">
                Tela de sucesso (segundos)

                <input
                  type="number"
                  min="2"
                  max="15"
                  value={
                    settings.successScreenMs / 1000
                  }
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      successScreenMs:
                        Number(e.target.value) * 1000,
                    })
                  }
                />
              </label>
            </div>

            <p className="field-hint">
              Entrada permitida até o fim da aula. Antes da
              janela de saída, repetir o CPF apenas informa que a
              entrada já foi registrada.
            </p>

            <button
              className="primary"
              disabled={busy}
            >
              Salvar regras
            </button>
          </form>
        </section>
      )}
    </>
  );
}