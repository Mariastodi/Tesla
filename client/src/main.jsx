import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import "./styles.css";
const Admin = lazy(() =>
  import("./Admin").then((module) => ({ default: module.Admin })),
);
const onlyDigits = (value) =>
  String(value || "")
    .replace(/\D/g, "")
    .slice(0, 11);
const cpfMask = (value) => {
  let i = 0;
  return "___.___.___-__".replace(/_/g, () => value[i++] || "_");
};
const initialData = {
  config: {},
  alunos: [],
  turmas: [],
  professores: [],
  checkins: [],
  attendance: [],
};
const post = (path, body) =>
  api(path, { method: "POST", body: JSON.stringify(body) });

function Dialog({ title, children, onClose, className = "" }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-top">
        <span className="eyebrow">TESLA</span>
        <button className="icon-button" aria-label="Fechar" onClick={onClose}>
          ×
        </button>
      </div>
      <h2 id="dialog-title">{title}</h2>
      {children}
    </dialog>
  );
}
function FirstAccess({ onSelect, onClose }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [state, setState] = useState("idle");
  useEffect(() => {
    setResults([]);
    if (query.trim().length < 3) {
      setState("idle");
      return;
    }
    const controller = new AbortController();
    setState("loading");
    const timer = setTimeout(
      () =>
        api(`/api/kiosk/roster?q=${encodeURIComponent(query.trim())}`, {
          signal: controller.signal,
        })
          .then((result) => {
            setResults(result.students);
            setState("ready");
          })
          .catch(() => {
            if (!controller.signal.aborted) setState("error");
          }),
      350,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return (
    <Dialog title="Vamos encontrar seu nome" onClose={onClose}>
      <p>
        Você já é aluno? Escolha seu cadastro para informar o CPF pela primeira
        vez.
      </p>
      <label className="field">
        Seu nome
        <input
          autoFocus
          type="search"
          autoComplete="off"
          maxLength={100}
          placeholder="Digite pelo menos 3 letras"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="student-results" aria-live="polite">
        {results.map((student) => (
          <button
            className="student-result"
            key={student.id}
            onClick={() => onSelect(student)}
          >
            <span>{student.nome}</span>
            <span aria-hidden="true">→</span>
          </button>
        ))}
        {state === "loading" && <p>Buscando seu cadastro…</p>}
        {state === "ready" && !results.length && (
          <p>
            Nenhum cadastro encontrado. Confira seu nome ou procure a
            coordenação.
          </p>
        )}
        {state === "idle" && (
          <p className="hint">
            Só aparecem alunos que ainda não cadastraram o CPF.
          </p>
        )}
        {state === "error" && (
          <p role="alert">Não foi possível buscar. Tente novamente.</p>
        )}
      </div>
      <button className="text-button" onClick={onClose}>
        Voltar
      </button>
    </Dialog>
  );
}
function App() {
  const [data, setData] = useState(initialData);
  const [screen, setScreen] = useState("kiosk");
  const [cpf, setCpf] = useState("");
  const [selected, setSelected] = useState(null);
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [deviceReady, setDeviceReady] = useState(true);
  const [connection, setConnection] = useState("loading");
  const [time, setTime] = useState(new Date());
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [adminTab, setAdminTab] = useState("hoje");
  const reset = () => {
    setCpf("");
    setSelected(null);
    setModal(null);
    setPin("");
    setLoginError("");
  };
  useEffect(() => {
    let active = true;
    const load = () =>
      api("/api/bootstrap")
        .then((result) => {
          if (active) {
            setData((current) => ({ ...current, config: result.config }));
            setDeviceReady(result.deviceReady !== false);
            setConnection("ready");
          }
        })
        .catch(() => {
          if (active) setConnection("offline");
        });
    load();
    const timer = setInterval(load, 30000);
    const clock = setInterval(() => setTime(new Date()), 1000);
    return () => {
      active = false;
      clearInterval(timer);
      clearInterval(clock);
    };
  }, []);
  useEffect(() => {
    if (!modal || !["registered", "already", "linked"].includes(modal.kind))
      return;
    const timer = setTimeout(reset, 5500);
    return () => clearTimeout(timer);
  }, [modal]);
  useEffect(() => {
    let timer;
    const renew = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          reset();
          setScreen("kiosk");
          setData((current) => ({ ...initialData, config: current.config }));
        },
        screen === "admin" ? 300000 : 90000,
      );
    };
    renew();
    window.addEventListener("pointerdown", renew);
    window.addEventListener("keydown", renew);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", renew);
      window.removeEventListener("keydown", renew);
    };
  }, [screen]);
  useEffect(() => {
    const handleKey = (event) => {
      if (
        screen !== "kiosk" ||
        modal ||
        busy ||
        (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) &&
          event.target.id !== "cpf")
      )
        return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        setCpf((current) => onlyDigits(current + event.key));
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        setCpf((current) => current.slice(0, -1));
      }
      if (event.key === "Escape") reset();
      if (event.key === "Enter" && event.target.tagName !== "BUTTON") confirm();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  });
  async function run(action) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setModal({
        kind: "error",
        title: "Não foi possível concluir",
        detail:
          error.name === "TimeoutError"
            ? "A conexão demorou. Tente novamente; uma presença já salva não será duplicada."
            : error.message,
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function showResult(result) {
    setCpf("");
    setSelected(null);
    setModal({
      kind: result.state,
      title:
        result.state === "registered"
          ? "Presença confirmada!"
          : "Você já registrou presença",
      detail: result.student.nome,
      session: result.session,
    });
  }
  async function handleSessions(result) {
    if (!result.sessions.length) {
      setCpf("");
      setSelected(null);
      setModal({
        kind: result.state === "linked" ? "linked" : "no-class",
        title:
          result.state === "linked"
            ? "CPF cadastrado!"
            : "Nenhuma aula disponível agora",
        detail:
          result.state === "linked"
            ? "Seu cadastro está pronto. A presença será registrada quando você voltar no horário da sua aula."
            : "Seu cadastro foi encontrado, mas nenhuma das suas turmas está no horário de presença. Confira com a coordenação.",
      });
      return;
    }
    if (result.sessions.length === 1)
      return showResult(
        await post("/api/kiosk/checkin", {
          cpf,
          sessionId: result.sessions[0].id,
        }),
      );
    setModal({
      kind: "sessions",
      title: "Qual é a sua aula?",
      sessions: result.sessions,
    });
  }
  function confirm() {
    if (cpf.length !== 11) return;
    run(async () => {
      if (selected)
        return handleSessions(
          await post("/api/kiosk/link", { cpf, alunoId: selected.id }),
        );
      const result = await post("/api/kiosk/identify", { cpf });
      if (result.state === "first-access") {
        setCpf("");
        setModal({
          kind: "unknown",
          title: "É seu primeiro acesso?",
          detail:
            "Este CPF ainda não está vinculado. Encontre seu nome e cadastre seu CPF para continuar.",
        });
        return;
      }
      return handleSessions(result);
    });
  }
  async function login(event) {
    event.preventDefault();
    setLoginError("");
    run(async () => {
      try {
        if (!deviceReady) {
          await api("/api/device/activate", {
            method: "POST",
            headers: { "x-admin-pin": pin },
            body: "{}",
          });
          setDeviceReady(true);
          reset();
          return;
        }
        const result = await api("/api/admin/overview", {
          headers: { "x-admin-pin": pin },
        });
        setData(result);
        setModal(null);
        setScreen("admin");
      } catch (error) {
        setLoginError(error.message);
        setPin("");
      }
    });
  }
  const date = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza",
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(time);
  const clock = time.toLocaleTimeString("pt-BR", {
    timeZone: "America/Fortaleza",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <>
      {screen === "admin" ? (
        <Suspense fallback={<p>Carregando painel…</p>}>
          <Admin
            data={data}
            pin={pin}
            tab={adminTab}
            onTab={setAdminTab}
            onBack={() => {
              reset();
              setScreen("kiosk");
              setData((current) => ({
                ...initialData,
                config: current.config,
              }));
            }}
            onConfig={(config) =>
              setData((current) => ({ ...current, config }))
            }
            onData={setData}
          />
        </Suspense>
      ) : (
        <section className="screen kiosk-screen">
          <header className="kiosk-header">
            <div className="brand">
              <img src="/logo-tesla.png" alt="Tesla" />
              <div>
                <strong>TESLA</strong>
                <span>
                  {data.config.escola || "Instituto Tecnológico Tesla"}
                </span>
              </div>
            </div>
            <div className="clock">
              <strong>{clock}</strong>
              <span>{date}</span>
            </div>
          </header>
          <main className="kiosk-main">
            {connection !== "ready" && (
              <p className="connection-notice" role="status">
                {connection === "loading"
                  ? "Conectando…"
                  : "Sem conexão. Aguarde para registrar sua presença."}
              </p>
            )}
            {!deviceReady && (
              <div className="device-notice" role="status">
                <strong>Ative este tablet para começar.</strong>
                <span>
                  A coordenação informa o código uma vez para liberar o uso por
                  30 dias.
                </span>
                <button
                  className="text-button"
                  onClick={() => {
                    reset();
                    setModal({ kind: "admin" });
                  }}
                >
                  Ativar tablet
                </button>
              </div>
            )}
            <div className="welcome">
              <h1>{selected ? "Cadastre seu CPF" : "Registre sua presença"}</h1>
              <p>{selected ? selected.nome : "Digite seu CPF e confirme."}</p>
            </div>
            <section className="entry" aria-label="Registro de presença">
              <label className="sr-only" htmlFor="cpf">
                {selected ? `CPF de ${selected.nome}` : "Digite seu CPF"}
              </label>
              <input
                id="cpf"
                className="cpf-display"
                inputMode="none"
                autoComplete="off"
                spellCheck="false"
                aria-describedby="cpf-help"
                placeholder="___.___.___-__"
                value={cpfMask(cpf)}
                onChange={(event) => setCpf(onlyDigits(event.target.value))}
                readOnly
              />
              <span id="cpf-help" className="sr-only">
                Use o teclado abaixo para digitar os 11 números.
              </span>
              <div className="keypad">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((value) => (
                  <button
                    className="key"
                    key={value}
                    disabled={busy}
                    onClick={() =>
                      setCpf((current) => onlyDigits(current + value))
                    }
                  >
                    {value}
                  </button>
                ))}
                <button
                  className="key action"
                  onClick={() => setCpf((current) => current.slice(0, -1))}
                  disabled={busy}
                  aria-label="Apagar último número"
                >
                  ⌫
                </button>
                <button
                  className="key"
                  disabled={busy}
                  onClick={() => setCpf((current) => onlyDigits(current + "0"))}
                >
                  0
                </button>
                <button className="key action" disabled={busy} onClick={reset}>
                  Cancelar
                </button>
              </div>
              <button
                className="confirm-button"
                disabled={
                  busy ||
                  cpf.length !== 11 ||
                  connection !== "ready" ||
                  !deviceReady
                }
                onClick={confirm}
              >
                {busy
                  ? "Conferindo…"
                  : selected
                    ? "Cadastrar e continuar"
                    : "Confirmar presença"}
                <span aria-hidden="true">→</span>
              </button>
            </section>
          </main>
          <footer className="kiosk-footer">
            <button
              className="footer-first-access"
              disabled={!deviceReady || busy}
              onClick={() => {
                setCpf("");
                setSelected(null);
                setModal({ kind: "first" });
              }}
            >
              {selected ? "Trocar aluno" : "Primeiro acesso"}
            </button>
            <button
              className="staff-button"
              disabled={busy}
              onClick={() => {
                reset();
                setModal({ kind: "admin" });
              }}
            >
              Coordenação
            </button>
          </footer>
        </section>
      )}
      {modal?.kind === "first" && (
        <FirstAccess
          onClose={reset}
          onSelect={(student) => {
            setSelected(student);
            setCpf("");
            setModal(null);
          }}
        />
      )}
      {modal?.kind === "admin" && (
        <Dialog
          title={
            deviceReady ? "Acesso da coordenação" : "Ativar tablet da escola"
          }
          onClose={reset}
        >
          <p>Use o código da escola para acessar a gestão acadêmica.</p>
          <form onSubmit={login}>
            <label className="field">
              Código de acesso
              <input
                autoFocus
                type="password"
                autoComplete="off"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                required
              />
            </label>
            {loginError && (
              <p className="form-error" role="alert">
                {loginError}
              </p>
            )}
            <button className="confirm-button" disabled={busy}>
              {busy
                ? "Conferindo…"
                : deviceReady
                  ? "Entrar no painel"
                  : "Ativar este tablet"}
            </button>
          </form>
        </Dialog>
      )}
      {modal && !["first", "admin"].includes(modal.kind) && (
        <Dialog
          title={modal.title}
          onClose={reset}
          className={`result ${modal.kind}`}
        >
          {modal.kind !== "unknown" && (
            <div className="result-symbol" aria-hidden="true">
              {modal.kind === "registered"
                ? "✓"
                : modal.kind === "error"
                  ? "!"
                  : "•"}
            </div>
          )}
          <p aria-live="polite">{modal.detail}</p>
          {modal.session && (
            <div className="session-summary">
              <strong>
                {modal.session.turma.curso || modal.session.turma.nome}
              </strong>
              <span>
                {modal.session.inicio} – {modal.session.fim}
                {modal.session.turma.sala
                  ? ` · ${modal.session.turma.sala}`
                  : ""}
              </span>
            </div>
          )}
          {modal.sessions?.map((session) => (
            <button
              className="student-result"
              disabled={busy}
              key={session.id}
              onClick={() =>
                run(async () =>
                  showResult(
                    await post("/api/kiosk/checkin", {
                      cpf,
                      sessionId: session.id,
                    }),
                  ),
                )
              }
            >
              {session.turma.curso || session.turma.nome} · {session.inicio}
            </button>
          ))}
          {modal.kind === "unknown" && (
            <button
              className="confirm-button"
              onClick={() => setModal({ kind: "first" })}
            >
              Encontrar meu nome
            </button>
          )}
          <button className="text-button" onClick={reset}>
            Voltar ao início
          </button>
          {["registered", "already", "linked"].includes(modal.kind) && (
            <p className="hint">A tela inicial volta em alguns segundos.</p>
          )}
        </Dialog>
      )}
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
