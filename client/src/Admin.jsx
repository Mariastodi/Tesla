import { TeacherAttendancePanel } from "./TeacherAttendancePanel";
import { useState, useId, cloneElement } from "react";
import { api } from "./api";
const csvCell = (value) => {
  const text = String(value ?? "");
  return `"${(/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replace(/"/g, '""')}"`;
};
const downloadCsv = (filename, headers, rows) => {
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
};
export function Admin({ data, pin, tab, onTab, onBack, onConfig, onData }) {
  const tabs = {
    hoje: "Hoje",
    frequencia: "Frequência",
    alunos: "Alunos",
    professores: "Professores",
    ponto: "Aulas dos professores",
    turmas: "Turmas e grade",
    ajustes: "Ajustes",
  };
  return (
    <section className="screen admin-screen">
      <header className="admin-header">
        <div>
          <span className="eyebrow">GESTÃO ACADÊMICA</span>
          <h1>Controle de presença</h1>
        </div>
        <button className="text-button" type="button" onClick={onBack}>
          Voltar ao totem
        </button>
      </header>
      <nav className="tabs">
        {Object.entries(tabs).map(([key, label]) => (
          <button
            className={`tab ${tab === key ? "active" : ""}`}
            type="button"
            key={key}
            onClick={() => onTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      <main className="admin-main">
        <AdminContent
          data={data}
          pin={pin}
          tab={tab}
          onConfig={onConfig}
          onData={onData}
        />
      </main>
    </section>
  );
}
function AdminContent({ data, pin, tab, onConfig, onData }) {
  if (tab === "ponto")
    return <TeacherAttendancePanel data={data} pin={pin} onConfig={onConfig} />;
  if (tab === "frequencia") return <Frequency data={data} />;
  if (tab === "alunos")
    return <StudentRegister data={data} pin={pin} onData={onData} />;
  if (tab === "professores")
    return <CrudTeachers data={data} pin={pin} onData={onData} />;
  if (tab === "turmas")
    return <CrudClasses data={data} pin={pin} onData={onData} />;
  if (tab === "ajustes")
    return <Settings data={data} pin={pin} onConfig={onConfig} />;
  return <Today data={data} />;
}
function Today({ data }) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
  }).format(new Date());
  const present = new Set(
    data.checkins
      .filter((item) => item.data === today)
      .map((item) => item.alunoId),
  );
  return (
    <>
      <div className="metrics">
        <Metric
          value={data.turmas.filter((item) => item.ativa !== false).length}
          label="Turmas ativas"
        />
        <Metric
          value={data.alunos.filter((item) => item.ativo !== false).length}
          label="Alunos ativos"
        />
        <Metric value={present.size} label="Presentes hoje" />
      </div>
      <Panel title="Registros recentes">
        <CheckinTable items={data.checkins.slice(0, 25)} />
      </Panel>
    </>
  );
}
function Frequency({ data }) {
  const rows = [...(data.attendance || [])].sort((a, b) =>
    a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }),
  );
  const exportFrequency = () =>
    downloadCsv(
      "frequencia-presenca.csv",
      [
        "Aluno",
        "Presenças",
        "Faltas",
        "Total de aulas",
        "Percentual",
        "Situação",
      ],
      rows.map((row) => [
        row.nome,
        row.presencas,
        row.faltas,
        row.total,
        `${row.percentual}%`,
        row.percentual >= Number(data.config.minimo || 75)
          ? "Regular"
          : "Atenção",
      ]),
    );
  return (
    <Panel title="Frequência por aluno">
      <div className="panel-actions">
        <span>
          Início do controle: {data.config.inicioControle || "não definido"}
        </span>
        <button className="text-button" type="button" onClick={exportFrequency}>
          Baixar CSV
        </button>
      </div>
      <Table
        headers={["Aluno", "Presenças", "Faltas", "Percentual", "Situação"]}
      >
        {rows.map((row) => (
          <tr key={row.alunoId}>
            <td>{row.nome}</td>
            <td>{row.presencas}</td>
            <td>{row.faltas}</td>
            <td>{row.percentual}%</td>
            <td>
              <span
                className={`tag ${row.percentual >= Number(data.config.minimo || 75) ? "ok" : "bad"}`}
              >
                {row.percentual >= Number(data.config.minimo || 75)
                  ? "Regular"
                  : "Atenção"}
              </span>
            </td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}
function StudentRegister({ data, pin, onData }) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
  }).format(new Date());

  const emptyForm = {
    nome: "",
    tel: "",
    cpf: "",
    turmaIds: [],
    desde: today,
  };

  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState(emptyForm);
  const [message, setMessage] = useState("");
  const [editMessage, setEditMessage] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("todos");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const activeStudents = data.alunos.filter(
    (student) => student.ativo !== false,
  );

  const hasCpf = (student) =>
    student.vinculo === "verificado" || student.vinculo === "auto";

  const visibleStudents = [...activeStudents]
    .filter((student) => {
      const normalizedQuery = query.trim().toLocaleLowerCase();
      if (
        normalizedQuery &&
        !student.nome.toLocaleLowerCase().includes(normalizedQuery)
      ) {
        return false;
      }

      if (filter === "com-cpf") return hasCpf(student);
      if (filter === "sem-cpf") return !hasCpf(student);
      return true;
    })
    .sort((a, b) =>
      a.nome.localeCompare(b.nome, "pt-BR", {
        sensitivity: "base",
      }),
    );

  const totalPages = Math.max(1, Math.ceil(visibleStudents.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStudents = visibleStudents.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  const updateStudents = (student) => {
    onData({
      ...data,
      alunos: data.alunos.map((item) =>
        item.id === student.id ? student : item,
      ),
    });
  };

  const register = async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/admin/students", {
        method: "POST",
        headers: { "x-admin-pin": pin },
        body: JSON.stringify(form),
      });
      onData({ ...data, alunos: [...data.alunos, result.student] });
      setForm({ ...emptyForm, desde: today });
      setMessage("Aluno cadastrado.");
    } catch (error) {
      setMessage(error.message);
    }
  };

  const exportStudents = () =>
    downloadCsv(
      "alunos-presenca.csv",
      ["Nome", "Telefone", "Turmas", "Desde", "Vínculo", "Ativo"],
      activeStudents
        .sort((a, b) =>
          a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }),
        )
        .map((student) => [
          student.nome,
          student.tel,
          (student.turmaIds || []).join(", "),
          student.desde,
          student.vinculo || "Pendente",
          student.ativo !== false ? "Sim" : "Não",
        ]),
    );

  const toggleClass = (id) =>
    setForm((current) => ({
      ...current,
      turmaIds: current.turmaIds.includes(id)
        ? current.turmaIds.filter((item) => item !== id)
        : [...current.turmaIds, id],
    }));

  const toggleEditClass = (id) =>
    setEditForm((current) => ({
      ...current,
      turmaIds: current.turmaIds.includes(id)
        ? current.turmaIds.filter((item) => item !== id)
        : [...current.turmaIds, id],
    }));

  const startEditing = (student) => {
    setEditing(student);
    setEditForm({
      nome: student.nome || "",
      tel: student.tel || "",
      cpf: "",
      turmaIds: [...(student.turmaIds || [])],
      desde: student.desde || today,
    });
    setEditMessage("");
  };

  const cancelEditing = () => {
    setEditing(null);
    setEditForm({ ...emptyForm, desde: today });
    setEditMessage("");
  };

  const saveEdit = async (event) => {
    event.preventDefault();
    if (!editing) return;

    try {
      const result = await api(`/api/admin/students/${editing.id}`, {
        method: "PUT",
        headers: { "x-admin-pin": pin },
        body: JSON.stringify(editForm),
      });

      updateStudents(result.student);
      setEditing(result.student);
      setEditForm((current) => ({ ...current, cpf: "" }));
      setEditMessage("Aluno atualizado.");
    } catch (error) {
      setEditMessage(error.message);
    }
  };

  const unlinkCpf = async () => {
    if (!editing) return;
    if (
      !window.confirm(
        `Desvincular o CPF do aluno ${editing.nome}? O aluno e o histórico serão mantidos.`,
      )
    ) {
      return;
    }

    try {
      const result = await api(`/api/admin/students/${editing.id}/cpf`, {
        method: "DELETE",
        headers: { "x-admin-pin": pin },
      });

      updateStudents(result.student);
      setEditing(result.student);
      setEditForm((current) => ({ ...current, cpf: "" }));
      setEditMessage("CPF desvinculado. O cadastro do aluno foi mantido.");
    } catch (error) {
      setEditMessage(error.message);
    }
  };

  const remove = async (student) => {
    if (
      !window.confirm(
        `Desativar o aluno ${student.nome}? O histórico de presença será mantido.`,
      )
    ) {
      return;
    }

    try {
      await api(`/api/admin/students/${student.id}`, {
        method: "DELETE",
        headers: { "x-admin-pin": pin },
      });

      if (editing?.id === student.id) cancelEditing();
      onData({
        ...data,
        alunos: data.alunos.map((item) =>
          item.id === student.id ? { ...item, ativo: false } : item,
        ),
      });
      setMessage("Aluno desativado. O histórico foi mantido.");
    } catch (error) {
      setMessage(error.message);
    }
  };

  const changeQuery = (value) => {
    setQuery(value);
    setPage(1);
  };

  const changeFilter = (value) => {
    setFilter(value);
    setPage(1);
  };

  return (
    <>
      <Panel title={editing ? "Editar aluno" : "Cadastrar aluno"}>
        <form onSubmit={editing ? saveEdit : register}>
          <div className="form-grid">
            <Field label="Nome completo">
              <input
                required
                minLength="3"
                value={editing ? editForm.nome : form.nome}
                onChange={(event) =>
                  editing
                    ? setEditForm({ ...editForm, nome: event.target.value })
                    : setForm({ ...form, nome: event.target.value })
                }
              />
            </Field>
            <Field label="Telefone">
              <input
                inputMode="tel"
                value={editing ? editForm.tel : form.tel}
                onChange={(event) =>
                  editing
                    ? setEditForm({ ...editForm, tel: event.target.value })
                    : setForm({ ...form, tel: event.target.value })
                }
              />
            </Field>
            <Field label={editing ? "Novo CPF (opcional)" : "CPF"}>
              <input
                required={!editing}
                inputMode="numeric"
                placeholder={editing ? "Deixe vazio para manter o atual" : ""}
                value={editing ? editForm.cpf : form.cpf}
                onChange={(event) =>
                  editing
                    ? setEditForm({ ...editForm, cpf: event.target.value })
                    : setForm({ ...form, cpf: event.target.value })
                }
              />
            </Field>
            <Field label="Início">
              <input
                type="date"
                value={editing ? editForm.desde : form.desde}
                onChange={(event) =>
                  editing
                    ? setEditForm({ ...editForm, desde: event.target.value })
                    : setForm({ ...form, desde: event.target.value })
                }
              />
            </Field>
          </div>

          <Field label="Turmas">
            <div className="class-checks">
              {[...data.turmas]
                .sort((a, b) =>
                  (a.curso || a.nome || a.id).localeCompare(
                    b.curso || b.nome || b.id,
                    "pt-BR",
                    { sensitivity: "base" },
                  ),
                )
                .map((classItem) => {
                const selectedIds = editing ? editForm.turmaIds : form.turmaIds;
                return (
                  <label
                    className={`class-check ${selectedIds.includes(classItem.id) ? "selected" : ""}`}
                    key={classItem.id}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(classItem.id)}
                      onChange={() =>
                        editing
                          ? toggleEditClass(classItem.id)
                          : toggleClass(classItem.id)
                      }
                    />
                    <span>
                      {classItem.id} · {classItem.curso || classItem.nome}
                    </span>
                  </label>
                );
              })}
            </div>
            <small className="field-hint">
              {(editing ? editForm.turmaIds : form.turmaIds).length
                ? `${(editing ? editForm.turmaIds : form.turmaIds).length} turma(s) selecionada(s)`
                : "Selecione uma ou mais turmas"}
            </small>
          </Field>

          <br />
          <button className="primary" type="submit">
            {editing ? "Salvar alterações" : "Cadastrar aluno"}
          </button>

          {editing && (
            <>
              <button
                className="text-button form-cancel"
                type="button"
                onClick={cancelEditing}
              >
                Cancelar
              </button>
              <button
                className="text-button danger-button"
                type="button"
                onClick={unlinkCpf}
              >
                Desvincular CPF
              </button>
            </>
          )}

          <span className="settings-message">
            {editing ? editMessage : message}
          </span>
        </form>
      </Panel>

      <Panel title="Alunos e vínculos">
        <div className="panel-actions">
          <span>
            {activeStudents.length} alunos ativos
            {query || filter !== "todos"
              ? ` · ${visibleStudents.length} encontrados`
              : ""}
          </span>
          <button
            className="text-button"
            type="button"
            onClick={exportStudents}
          >
            Baixar CSV
          </button>
        </div>

        <div className="form-grid">
          <Field label="Buscar aluno por nome">
            <input
              type="search"
              placeholder="Digite o nome do aluno..."
              value={query}
              onChange={(event) => changeQuery(event.target.value)}
            />
          </Field>
        </div>

        <div className="row-actions">
          {[
            ["todos", "Todos"],
            ["com-cpf", "Com CPF"],
            ["sem-cpf", "Sem CPF"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={`text-button ${filter === value ? "active" : ""}`}
              type="button"
              onClick={() => changeFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {pageStudents.length ? (
          <Table headers={["Aluno", "Turmas", "Estado", "Ações"]}>
            {pageStudents.map((student) => (
              <tr key={student.id}>
                <td>{student.nome}</td>
                <td>{student.turmaIds?.join(", ") || "—"}</td>
                <td>
                  <span
                    className={`tag ${hasCpf(student) ? (student.vinculo === "verificado" ? "ok" : "warn") : "bad"}`}
                  >
                    {student.vinculo === "verificado"
                      ? "CPF cadastrado"
                      : student.vinculo === "auto"
                        ? "CPF autovinculado"
                        : "Sem CPF"}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => startEditing(student)}
                    >
                      Editar
                    </button>
                    <button
                      className="text-button danger-button"
                      type="button"
                      onClick={() => remove(student)}
                    >
                      Apagar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="empty">Nenhum aluno encontrado.</div>
        )}

        {totalPages > 1 && (
          <div className="panel-actions">
            <button
              className="text-button"
              type="button"
              disabled={currentPage === 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              ← Anterior
            </button>
            <span>
              Página {currentPage} de {totalPages}
            </span>
            <button
              className="text-button"
              type="button"
              disabled={currentPage === totalPages}
              onClick={() =>
                setPage((value) => Math.min(totalPages, value + 1))
              }
            >
              Próxima →
            </button>
          </div>
        )}
      </Panel>
    </>
  );
}

function CrudTeachers({ data, pin, onData }) {
  const [form, setForm] = useState({ nome: "", cpf: "" });
  const [editing, setEditing] = useState(null);
  const [message, setMessage] = useState("");
  const teachers = (data.professores || []).filter(
    (teacher) => teacher.ativo !== false,
  );
  async function save(event) {
    event.preventDefault();
    try {
      const result = await api(
        editing ? `/api/admin/teachers/${editing.id}` : "/api/admin/teachers",
        {
          method: editing ? "PUT" : "POST",
          headers: { "x-admin-pin": pin },
          body: JSON.stringify(form),
        },
      );
      const next = editing
        ? teachers.map((item) =>
            item.id === editing.id ? result.professor : item,
          )
        : [...data.professores, result.professor];
      onData({
        ...data,
        professores: next,
        turmas: result.turmas || data.turmas,
      });
      setForm({ nome: "", cpf: "" });
      setEditing(null);
      setMessage(editing ? "Professor atualizado." : "Professor cadastrado.");
    } catch (error) {
      setMessage(error.message);
    }
  }
  async function remove(teacher) {
    if (!window.confirm(`Apagar o professor ${teacher.nome}?`)) return;
    try {
      await api(`/api/admin/teachers/${teacher.id}`, {
        method: "DELETE",
        headers: { "x-admin-pin": pin },
      });
      onData({
        ...data,
        professores: data.professores.map((item) =>
          item.id === teacher.id ? { ...item, ativo: false } : item,
        ),
      });
      setMessage("Professor apagado.");
    } catch (error) {
      setMessage(error.message);
    }
  }
  return (
    <>
      <Panel title={editing ? "Editar professor" : "Cadastrar professor"}>
        <form onSubmit={save}>
          <div className="form-grid">
            <Field label="Nome completo">
              <input
                required
                minLength="3"
                value={form.nome}
                onChange={(event) =>
                  setForm({ ...form, nome: event.target.value })
                }
              />
            </Field>
            <Field label="CPF">
              <input
                required={!editing}
                inputMode="numeric"
                placeholder={
                  editing ? "Preencha para cadastrar ou corrigir o CPF" : ""
                }
                value={form.cpf}
                onChange={(event) =>
                  setForm({ ...form, cpf: event.target.value })
                }
              />
            </Field>
          </div>
          <br />
          <button className="primary" type="submit">
            {editing ? "Salvar alterações" : "Cadastrar professor"}
          </button>
          {editing && (
            <button
              className="text-button form-cancel"
              type="button"
              onClick={() => {
                setEditing(null);
                setForm({ nome: "", cpf: "" });
              }}
            >
              Cancelar
            </button>
          )}
          <span className="settings-message">{message}</span>
        </form>
      </Panel>
      <Panel title="Professores cadastrados">
        <Table headers={["Professor", "Situação", "Ações"]}>
          {[...teachers]
            .sort((a, b) =>
              a.nome.localeCompare(b.nome, "pt-BR", {
                sensitivity: "base",
              }),
            )
            .map((teacher) => (
            <tr key={teacher.id}>
              <td>{teacher.nome}</td>
              <td>
                <span
                  className={`tag ${teacher.cpfStatus === "verificado" ? "ok" : "warn"}`}
                >
                  {teacher.cpfStatus === "verificado"
                    ? "Verificado"
                    : "Legado, CPF pendente"}
                </span>
              </td>
              <td>
                <div className="row-actions">
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      setEditing(teacher);
                      setForm({ nome: teacher.nome, cpf: "" });
                    }}
                  >
                    Editar
                  </button>
                  <button
                    className="text-button danger-button"
                    type="button"
                    onClick={() => remove(teacher)}
                  >
                    Apagar
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}
function CrudClasses({ data, pin, onData }) {
  const days = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const empty = {
    id: "",
    curso: "",
    professorId: "",
    sala: "",
    horarios: [{ dia: 1, inicio: "18:30", fim: "21:30" }],
    dataInicio: new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Fortaleza",
    }).format(new Date()),
    dataFim: "",
  };
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState(null);
  const [message, setMessage] = useState("");
  const activeTeachers = (data.professores || []).filter(
    (teacher) => teacher.ativo !== false,
  );
  const fill = (item) =>
    setForm({
      id: item.id,
      curso: item.curso || "",
      professorId: item.professorId || "",
      sala: item.sala || "",
      horarios: (item.horarios?.length ? item.horarios : empty.horarios).map(
        (h) => ({ ...h }),
      ),
      dataInicio: item.inicio || empty.dataInicio,
      dataFim: item.fim || "",
    });
  async function save(event) {
    event.preventDefault();
    try {
      const result = await api(
        editing ? `/api/admin/classes/${editing.id}` : "/api/admin/classes",
        {
          method: editing ? "PUT" : "POST",
          headers: { "x-admin-pin": pin },
          body: JSON.stringify(form),
        },
      );
      const next = editing
        ? data.turmas.map((item) =>
            item.id === editing.id ? result.turma : item,
          )
        : [...data.turmas, result.turma];
      onData({ ...data, turmas: next });
      setForm(empty);
      setEditing(null);
      setMessage(editing ? "Turma atualizada." : "Turma cadastrada.");
    } catch (error) {
      setMessage(error.message);
    }
  }
  async function remove(item) {
    if (!window.confirm(`Apagar a turma ${item.id}?`)) return;
    try {
      await api(`/api/admin/classes/${item.id}`, {
        method: "DELETE",
        headers: { "x-admin-pin": pin },
      });
      onData({
        ...data,
        turmas: data.turmas.filter((current) => current.id !== item.id),
      });
      setMessage("Turma apagada.");
    } catch (error) {
      setMessage(error.message);
    }
  }
  return (
    <>
      <Panel title={editing ? "Editar turma" : "Cadastrar turma"}>
        <form onSubmit={save}>
          <div className="form-grid">
            <Field label="Código">
              <input
                required
                disabled={Boolean(editing)}
                value={form.id}
                onChange={(event) =>
                  setForm({ ...form, id: event.target.value })
                }
              />
            </Field>
            <Field label="Curso">
              <input
                required
                value={form.curso}
                onChange={(event) =>
                  setForm({ ...form, curso: event.target.value })
                }
              />
            </Field>
            <Field label="Professor">
              <select
                required
                value={form.professorId}
                onChange={(event) =>
                  setForm({ ...form, professorId: event.target.value })
                }
              >
                <option value="">Selecione</option>
                {[...activeTeachers]
                  .sort((a, b) =>
                    a.nome.localeCompare(b.nome, "pt-BR", {
                      sensitivity: "base",
                    }),
                  )
                  .map((teacher) => (
                  <option key={teacher.id} value={teacher.id}>
                    {teacher.nome}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sala">
              <input
                value={form.sala}
                onChange={(event) =>
                  setForm({ ...form, sala: event.target.value })
                }
              />
            </Field>
            <Field label="Data de início">
              <input
                type="date"
                required
                value={form.dataInicio}
                onChange={(event) =>
                  setForm({ ...form, dataInicio: event.target.value })
                }
              />
            </Field>
          </div>
          <fieldset className="schedule-editor">
            <legend>Horários da turma</legend>
            {form.horarios.map((schedule, index) => (
              <div className="form-grid" key={index}>
                <Field label="Dia">
                  <select
                    value={schedule.dia}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        horarios: form.horarios.map((h, i) =>
                          i === index
                            ? { ...h, dia: Number(e.target.value) }
                            : h,
                        ),
                      })
                    }
                  >
                    {days.map((day, i) => (
                      <option key={day} value={i}>
                        {day}
                      </option>
                    ))}
                  </select>
                </Field>
                {["inicio", "fim"].map((key) => (
                  <Field
                    key={key}
                    label={key === "inicio" ? "Início da aula" : "Fim da aula"}
                  >
                    <input
                      type="time"
                      required
                      value={schedule[key]}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          horarios: form.horarios.map((h, i) =>
                            i === index ? { ...h, [key]: e.target.value } : h,
                          ),
                        })
                      }
                    />
                  </Field>
                ))}
                <button
                  className="text-button"
                  type="button"
                  disabled={form.horarios.length === 1}
                  onClick={() =>
                    setForm({
                      ...form,
                      horarios: form.horarios.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remover horário
                </button>
              </div>
            ))}
            <button
              className="text-button"
              type="button"
              disabled={form.horarios.length >= 30}
              onClick={() =>
                setForm({
                  ...form,
                  horarios: [
                    ...form.horarios,
                    { dia: 1, inicio: "18:30", fim: "21:30" },
                  ],
                })
              }
            >
              Adicionar horário
            </button>
          </fieldset>
          <br />
          <button className="primary" type="submit">
            {editing ? "Salvar alterações" : "Cadastrar turma"}
          </button>
          {editing && (
            <button
              className="text-button form-cancel"
              type="button"
              onClick={() => {
                setEditing(null);
                setForm(empty);
              }}
            >
              Cancelar
            </button>
          )}
          <span className="settings-message">{message}</span>
        </form>
      </Panel>
      <Panel title="Grade cadastrada">
        <Table
          headers={[
            "Código",
            "Curso",
            "Professor",
            "Horários",
            "Alunos",
            "Ações",
          ]}
        >
          {[...data.turmas]
            .sort((a, b) =>
              (a.curso || a.nome || a.id).localeCompare(
                b.curso || b.nome || b.id,
                "pt-BR",
                { sensitivity: "base" },
              ),
            )
            .map((item) => (
            <tr key={item.id}>
              <td>{item.id}</td>
              <td>{item.curso || item.nome}</td>
              <td>{item.professor || ""}</td>
              <td>
                {(item.horarios || [])
                  .map(
                    (schedule) =>
                      `${days[schedule.dia]} ${schedule.inicio} até ${schedule.fim}`,
                  )
                  .join(" | ")}
              </td>
              <td>
                {
                  data.alunos.filter(
                    (student) =>
                      (student.turmaIds || []).includes(item.id) &&
                      student.ativo !== false,
                  ).length
                }
              </td>
              <td>
                <div className="row-actions">
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      setEditing(item);
                      fill(item);
                    }}
                  >
                    Editar
                  </button>
                  <button
                    className="text-button danger-button"
                    type="button"
                    onClick={() => remove(item)}
                  >
                    Apagar
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}
function Settings({ data, pin, onConfig }) {
  const [form, setForm] = useState(data.config);
  const [message, setMessage] = useState("");
  async function save(event) {
    event.preventDefault();
    try {
      const result = await api("/api/admin/config", {
        method: "PUT",
        headers: { "x-admin-pin": pin },
        body: JSON.stringify(form),
      });
      onConfig(result.config);
      setForm(result.config);
      setMessage("Ajustes salvos.");
    } catch {
      setMessage("Não foi possível salvar.");
    }
  }
  return (
    <Panel title="Configuração do sistema">
      <form onSubmit={save}>
        <div className="form-grid">
          <Field label="Nome exibido">
            <input
              value={form.escola || ""}
              onChange={(event) =>
                setForm({ ...form, escola: event.target.value })
              }
            />
          </Field>
          <Field label="Frequência mínima">
            <input
              type="number"
              min="0"
              max="100"
              value={form.minimo || 0}
              onChange={(event) =>
                setForm({ ...form, minimo: event.target.value })
              }
            />
          </Field>
          <Field label="Tolerância antes">
            <input
              type="number"
              min="0"
              value={form.tolAntes || 0}
              onChange={(event) =>
                setForm({ ...form, tolAntes: event.target.value })
              }
            />
          </Field>
          <Field label="Tolerância depois">
            <input
              type="number"
              min="0"
              value={form.tolDepois || 0}
              onChange={(event) =>
                setForm({ ...form, tolDepois: event.target.value })
              }
            />
          </Field>
          <Field label="Início do controle">
            <input
              type="date"
              value={form.inicioControle || ""}
              onChange={(event) =>
                setForm({ ...form, inicioControle: event.target.value })
              }
            />
          </Field>
        </div>
        <br />
        <button className="primary" type="submit">
          Salvar ajustes
        </button>
        <span className="settings-message">{message}</span>
      </form>
    </Panel>
  );
}
function Field({ label, children }) {
  const id = useId();
  if (["input", "select", "textarea"].includes(children.type)) {
    const required = Boolean(children.props.required);
    return (
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {label}
          {required && (
            <span className="required-mark" aria-hidden="true">
              {" "}*
            </span>
          )}
        </label>
        {cloneElement(children, { id })}
      </div>
    );
  }
  return (
    <fieldset className="field field-group">
      <legend className="field-label">{label}</legend>
      {children}
    </fieldset>
  );
}
function Metric({ value, label }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
function Panel({ title, children }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function Table({ headers, children }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function CheckinTable({ items }) {
  if (!items.length)
    return <div className="empty">Nenhum registro recente.</div>;
  return (
    <Table headers={["Aluno", "Data", "Hora", "Sessão"]}>
      {items.map((item) => (
        <tr key={item.id}>
          <td>{item.alunoNome}</td>
          <td>{item.data}</td>
          <td>{item.hora}</td>
          <td>{item.turmaId}</td>
        </tr>
      ))}
    </Table>
  );
}
