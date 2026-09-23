import {
  dateKey,
  minutes,
  sessionFrom,
  matchesCpf,
  validCpf,
  now,
} from "./domain.js";

export const teacherDefaults = Object.freeze({
  entryBefore: 30,
  exitBefore: 60,
  exitAfter: 60,
  duplicateMinutes: 5,
});
export function teacherSettings(config = {}) {
  return { ...teacherDefaults, ...config.teacherAttendanceSettings };
}
export function validateTeacherSettings(input) {
  const result = {};
  for (const key of Object.keys(teacherDefaults)) {
    const value = Number(input[key] ?? teacherDefaults[key]);
    if (
      !Number.isInteger(value) ||
      value < (key === "duplicateMinutes" ? 1 : 0) ||
      value > 240
    )
      throw new Error(
        "Informe tolerâncias entre 0 e 240 minutos (intervalo entre registros: 1 a 240).",
      );
    result[key] = value;
  }
  return result;
}
const error = (status, message) => ({ status, body: { error: message } });
export function sessionsOn(store, date) {
  const day = new Date(`${date}T12:00:00-03:00`).getDay();
  return store.turmas.flatMap((turma) => {
    if (
      turma.ativa === false ||
      (turma.inicio && turma.inicio > date) ||
      (turma.fim && turma.fim < date)
    )
      return [];
    return (turma.horarios || [])
      .filter((h) => Number(h.dia) === day)
      .map((h) => sessionFrom(turma, h, date))
      .filter((s) => !(turma.canceladas || []).includes(s.id));
  });
}
export function expectedTeacher(store, session) {
  return (
    store.teacherSubstitutions?.find((s) => s.sessionId === session.id)
      ?.professorId || session.turma.professorId
  );
}
function displayRecord(record) {
  const time = (value) =>
    value
      ? new Date(value).toLocaleTimeString("pt-BR", {
          timeZone: "America/Fortaleza",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
  const { requestIds, ...publicRecord } = record;
  return {
    ...publicRecord,
    entradaHora: time(record.entrada),
    saidaHora: time(record.saida),
  };
}
export function registerTeacherAttendance(store, input, current = now()) {
  if (!validCpf(input.cpf)) return error(422, "CPF inválido.");
  const teacher = store.professores.find(
    (t) => t.ativo !== false && matchesCpf(t, input.cpf),
  );
  if (!teacher) return error(404, "Professor não encontrado.");
  if (
    typeof input.requestId !== "string" ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)
  )
    return error(422, "Identificador do registro inválido. Tente novamente.");
  const publicTeacher = { id: teacher.id, nome: teacher.nome };
  const records = (store.teacherAttendance ||= []);
  const replay = records.find(
    (r) =>
      r.professorId === teacher.id && r.requestIds?.includes(input.requestId),
  );
  if (replay)
    return {
      status: 200,
      body: {
        state: "already",
        message: replay.saida
          ? "Saída já registrada para esta aula."
          : "Entrada já registrada para esta aula.",
        teacher: publicTeacher,
        record: displayRecord(replay),
      },
    };
  const date = dateKey(current);
  const time = current.getHours() * 60 + current.getMinutes();
  const settings = teacherSettings(store.config);
  const sessions = sessionsOn(store, date).filter(
    (s) => expectedTeacher(store, s) === teacher.id,
  );
  // Keep the recorded schedule when a class is edited after the teacher arrives.
  for (const r of records.filter(
    (r) => r.professorId === teacher.id && r.data === date && !r.saida,
  )) {
    const snapshot = {
      id: r.sessionId,
      data: r.data,
      inicio: r.horarioInicioPrevisto,
      fim: r.horarioFimPrevisto,
      turmaId: r.turmaId,
      turma: {
        id: r.turmaId,
        nome: r.turmaNome,
        professorId: r.professorPrevistoId,
      },
    };
    const index = sessions.findIndex((s) => s.id === r.sessionId);
    if (index >= 0) sessions[index] = snapshot;
    else sessions.push(snapshot);
  }
  const candidates = sessions.filter(
    (s) =>
      time >= minutes(s.inicio) - settings.entryBefore &&
      time <= minutes(s.fim) + settings.exitAfter,
  );
  let selected;
  if (input.sessionId)
    selected = candidates.find((s) => s.id === input.sessionId);
  else {
    const active = candidates.filter(
      (s) => time >= minutes(s.inicio) && time <= minutes(s.fim),
    );
    const choices = active.length ? active : candidates;
    if (choices.length > 1)
      return {
        status: 200,
        body: {
          state: "choose",
          options: choices.map((s) => ({
            id: s.id,
            turmaNome: s.turma.curso || s.turma.nome,
            inicio: s.inicio,
            fim: s.fim,
            action: records.some(
              (r) => r.sessionId === s.id && r.professorId === teacher.id,
            )
              ? "exit"
              : "entry",
          })),
        },
      };
    selected = choices[0];
  }
  if (!selected) {
    const upcoming = sessions
      .filter((s) => minutes(s.inicio) > time)
      .sort((a, b) => minutes(a.inicio) - minutes(b.inicio))[0];
    return error(
      input.sessionId ? 409 : 422,
      upcoming
        ? `Sua próxima aula começa às ${upcoming.inicio}. Aguarde a janela de entrada.`
        : "Você não possui aula prevista neste horário.",
    );
  }
  const occupied = records.find((r) => r.sessionId === selected.id);
  if (occupied && occupied.professorId !== teacher.id)
    return error(
      409,
      "Esta aula já possui ponto de outro professor. Procure a coordenação.",
    );
  const response = (state, message, record, changed = false) => ({
    status: 200,
    changed,
    body: {
      state,
      message,
      teacher: publicTeacher,
      record: displayRecord(record),
    },
  });
  if (occupied?.saida)
    return response("already", "Saída já registrada para esta aula.", occupied);
  if (occupied) {
    const elapsed = (current - new Date(occupied.entrada)) / 60000;
    if (
      elapsed < settings.duplicateMinutes ||
      time < minutes(selected.fim) - settings.exitBefore
    )
      return response(
        "already",
        "Entrada já registrada para esta aula.",
        occupied,
      );
    occupied.saida = current.toISOString();
    occupied.updatedAt = current.toISOString();
    occupied.status = "Concluído";
    occupied.requestIds.push(input.requestId);
    return response("registered", "Saída registrada!", occupied, true);
  }
  if (time > minutes(selected.fim))
    return error(
      409,
      "Não existe entrada registrada para este período. Procure a coordenação.",
    );
  const titular = store.professores.find(
    (t) => t.id === selected.turma.professorId,
  );
  const record = {
    id: selected.id,
    sessionId: selected.id,
    turmaId: selected.turmaId,
    turmaNome: selected.turma.curso || selected.turma.nome,
    professorId: teacher.id,
    professorNome: teacher.nome,
    professorPrevistoId: selected.turma.professorId,
    professorPrevistoNome:
      titular?.nome || selected.turma.professor || "Não informado",
    data: date,
    horarioInicioPrevisto: selected.inicio,
    horarioFimPrevisto: selected.fim,
    entrada: current.toISOString(),
    saida: null,
    tipoProfessor:
      selected.turma.professorId === teacher.id ? "Titular" : "Substituto",
    status: "Em aula",
    createdAt: current.toISOString(),
    updatedAt: current.toISOString(),
    requestIds: [input.requestId],
  };
  records.push(record);
  return response("registered", "Entrada registrada!", record, true);
}
