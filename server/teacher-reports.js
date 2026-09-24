import ExcelJS from "exceljs";
import { dateKey, minutes, now } from "./domain.js";
import {
  sessionsOn,
  expectedTeacher,
  teacherSettings,
} from "./teacher-attendance.js";

const serialDate = (date) =>
  (Date.parse(`${date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("pt-BR", {
        timeZone: "America/Fortaleza",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
const weekday = (date) =>
  new Date(`${date}T12:00:00-03:00`).toLocaleDateString("pt-BR", {
    weekday: "long",
    timeZone: "America/Fortaleza",
  });
export function reportRange(query = {}, current = now()) {
  const today = dateKey(current);
  const from = query.from || `${today.slice(0, 7)}-01`,
    to = query.to || today;
  const valid = (date) =>
    typeof date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;
  if (
    !valid(from) ||
    !valid(to) ||
    to < from ||
    (Date.parse(to) - Date.parse(from)) / 86400000 > 92
  )
    throw new Error("Selecione um período válido de até 93 dias.");
  return { from, to };
}
export function buildTeacherReport(store, query = {}, current = now()) {
  const range = reportRange(query, current);
  const records = (store.teacherAttendance || []).filter(
    (r) => r.data >= range.from && r.data <= range.to,
  );
  const rows = records.map((r) => ({
    ...r,
    status:
      !r.saida &&
      current > new Date(`${r.data}T${r.horarioFimPrevisto}:00-03:00`)
        ? "Saída pendente"
        : r.status,
  }));
  const start = new Date(`${range.from}T12:00:00-03:00`);
  for (
    const date = new Date(start);
    dateKey(date) <= range.to;
    date.setDate(date.getDate() + 1)
  ) {
    const key = dateKey(date);
    if (
      store.config.teacherAttendanceStart &&
      key < store.config.teacherAttendanceStart
    )
      continue;
    // Do not infer missed classes before teacher attendance was enabled.
    if (!store.config.teacherAttendanceStart) continue;
    for (const s of sessionsOn(store, key)) {
      if (records.some((r) => r.sessionId === s.id)) continue;
      const teacherId = expectedTeacher(store, s);
      const teacher = store.professores.find((t) => t.id === teacherId);
      if (!teacher) continue;
      const finished =
        current >
        new Date(
          new Date(`${key}T${s.fim}:00-03:00`).getTime() +
            teacherSettings(store.config).exitAfter * 60000,
        );
      rows.push({
        id: s.id,
        sessionId: s.id,
        data: key,
        turmaId: s.turmaId,
        turmaNome: s.turma.curso || s.turma.nome,
        professorId: teacherId,
        professorNome: teacher.nome,
        professorPrevistoId: s.turma.professorId,
        professorPrevistoNome: s.turma.professor || "Não informado",
        horarioInicioPrevisto: s.inicio,
        horarioFimPrevisto: s.fim,
        entrada: null,
        saida: null,
        tipoProfessor:
          teacherId === s.turma.professorId ? "Titular" : "Substituto",
        status: finished ? "Sem registro" : "Prevista",
      });
    }
  }
  rows.sort((a, b) =>
    `${a.data}${a.horarioInicioPrevisto}${a.turmaId}`.localeCompare(
      `${b.data}${b.horarioInicioPrevisto}${b.turmaId}`,
    ),
  );
  const summary = new Map();
  for (const row of rows) {
    row.minutosPrevistos =
      minutes(row.horarioFimPrevisto) - minutes(row.horarioInicioPrevisto);
    row.minutosRealizados =
      row.saida && row.entrada
        ? Math.round((Date.parse(row.saida) - Date.parse(row.entrada)) / 60000)
        : null;
    row.diferencaMinutos =
      row.minutosRealizados === null
        ? null
        : row.minutosRealizados - row.minutosPrevistos;
    row.entradaHora = clock(row.entrada);
    row.saidaHora = clock(row.saida);
    delete row.requestIds;
    const s = summary.get(row.professorId) || {
      professor: row.professorNome,
      previstos: 0,
      realizados: 0,
      diferenca: 0,
      aulas: 0,
      substituicoes: 0,
      semRegistro: 0,
      pendentes: 0,
    };
    s.previstos += row.minutosPrevistos;
    s.realizados += row.minutosRealizados || 0;
    s.diferenca += row.diferencaMinutos || 0;
    s.aulas++;
    s.substituicoes += row.tipoProfessor === "Substituto" ? 1 : 0;
    s.semRegistro += row.status === "Sem registro" ? 1 : 0;
    s.pendentes += row.entrada && !row.saida ? 1 : 0;
    summary.set(row.professorId, s);
  }
  const orderedSummary = [...summary.values()].sort((a, b) =>
    a.professor.localeCompare(b.professor, "pt-BR", {
      sensitivity: "base",
    }),
  );
  return { range, rows, summary: orderedSummary };
}
export function workbookTables(store, report) {
  const headers = [
    "Data",
    "Dia",
    "Professor planejado",
    "Professor da aula",
    "Turma",
    "Início planejado",
    "Término planejado",
    "Início registrado",
    "Conclusão registrada",
    "Duração planejada",
    "Duração registrada",
    "Variação (min)",
    "Status",
    "Tipo",
    "ID da aula",
  ];
  const tables = [
    {
      name: "REGISTROS",
      headers,
      widths: [14, 20, 30, 32, 32, 16, 16, 14, 14, 18, 18, 20, 22, 16, 40],
      formats: {
        0: "dd/mm/yyyy",
        5: "hh:mm",
        6: "hh:mm",
        7: "hh:mm",
        8: "hh:mm",
        9: "[h]:mm",
        10: "[h]:mm",
      },
      rows: report.rows.map((r) => [
        serialDate(r.data),
        weekday(r.data),
        r.professorPrevistoNome,
        r.professorNome,
        r.turmaNome,
        minutes(r.horarioInicioPrevisto) / 1440,
        minutes(r.horarioFimPrevisto) / 1440,
        r.entradaHora ? minutes(r.entradaHora) / 1440 : "",
        r.saidaHora ? minutes(r.saidaHora) / 1440 : "",
        r.minutosPrevistos / 1440,
        r.minutosRealizados === null ? "" : r.minutosRealizados / 1440,
        r.diferencaMinutos ?? "",
        r.status,
        r.tipoProfessor,
        r.sessionId,
      ]),
    },
    {
      name: "RESUMO",
      headers: [
        "Professor",
        "Duração planejada",
        "Duração registrada",
        "Variação registrada (min)",
        "Aulas",
        "Substituições",
        "Sem registro",
        "Conclusões pendentes",
      ],
      widths: [32, 20, 22, 30, 12, 18, 18, 22],
      formats: { 1: "[h]:mm", 2: "[h]:mm" },
      rows: report.summary.map((s) => [
        s.professor,
        s.previstos / 1440,
        s.realizados / 1440,
        s.diferenca,
        s.aulas,
        s.substituicoes,
        s.semRegistro,
        s.pendentes,
      ]),
    },
    {
      name: "PROFESSORES",
      headers: ["ID", "Professor", "Status", "CPF cadastrado"],
      widths: [40, 36, 16, 20],
      rows: store.professores.map((t) => [
        t.id,
        t.nome,
        t.ativo === false ? "Inativo" : "Ativo",
        t.cpfHash ? "Sim" : "Pendente",
      ]),
    },
    {
      name: "TURMAS",
      headers: [
        "Código",
        "Curso",
        "Professor titular",
        "Sala",
        "Início",
        "Fim",
        "Status",
      ],
      widths: [20, 36, 32, 20, 14, 14, 16],
      rows: store.turmas.map((t) => [
        t.id,
        t.curso || t.nome,
        t.professor || "",
        t.sala || "",
        t.inicio || "",
        t.fim || "",
        t.ativa === false ? "Inativa" : "Ativa",
      ]),
    },
    {
      name: "HORARIOS",
      headers: ["Turma", "Professor titular", "Dia", "Início", "Fim"],
      widths: [30, 32, 20, 14, 14],
      formats: { 3: "hh:mm", 4: "hh:mm" },
      rows: store.turmas.flatMap((t) =>
        (t.horarios || []).map((h) => [
          t.id,
          t.professor || "",
          [
            "Domingo",
            "Segunda-feira",
            "Terça-feira",
            "Quarta-feira",
            "Quinta-feira",
            "Sexta-feira",
            "Sábado",
          ][h.dia],
          minutes(h.inicio) / 1440,
          minutes(h.fim) / 1440,
        ]),
      ),
    },
    {
      name: "LEIA-ME",
      headers: ["Informação", "Detalhe"],
      widths: [32, 110],
      rows: [
        ["Período", `${report.range.from} a ${report.range.to}`],
        [
          "Abrangência",
          report.online
            ? "RESUMO: período acima. REGISTROS: período acima e os registros anteriores."
            : "Todas as abas de registro consideram o período acima.",
        ],
        ["Fuso horário", "America/Fortaleza (UTC-3)"],
        ["Fonte", "Banco de dados Tesla. A planilha é uma cópia de consulta."],
        [
          "Sem registro",
          "Não há registro para uma aula prevista. Isso não confirma falta nem calcula valores de pagamento.",
        ],
        [
          "Saída pendente",
          "Duração e variação ficam vazias até que o início e a conclusão sejam registrados.",
        ],
        [
          "Resumo",
          "A variação considera somente aulas com início e conclusão registrados.",
        ],
        [
          "Histórico previsto",
          "Aulas sem registro usam a grade atual; alterações posteriores na grade podem mudar essas linhas.",
        ],
        ["CPF", "O CPF completo e seu hash não são enviados para a planilha."],
        [
          "Edição",
          "As abas de sincronização são atualizadas automaticamente; faça anotações em outra aba.",
        ],
      ],
    },
  ];
  return tables;
}
export async function exportTeacherWorkbook(store, report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Tesla";
  for (const table of workbookTables(store, report)) {
    const sheet = workbook.addWorksheet(table.name, {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.columns = table.headers.map((header, i) => ({
      header,
      width: table.widths[i],
    }));
    sheet.addRows(table.rows);
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, sheet.rowCount), column: table.headers.length },
    };
    sheet.getRow(1).height = 32;
    sheet.getRow(1).eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF072248" },
      };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.alignment = { vertical: "middle", wrapText: true };
    });
    for (let r = 2; r <= sheet.rowCount; r++) {
      sheet.getRow(r).eachCell((cell, c) => {
        cell.alignment = { vertical: "middle", wrapText: true };
        if (r % 2 === 0)
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFEAF2FB" },
          };
        if (table.formats?.[c - 1]) cell.numFmt = table.formats[c - 1];
      });
    }
  }
  return workbook.xlsx.writeBuffer();
}
