import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { hashCpf } from "../server/domain.js";
import {
  registerTeacherAttendance,
  validateTeacherSettings,
} from "../server/teacher-attendance.js";
import {
  buildTeacherReport,
  exportTeacherWorkbook,
} from "../server/teacher-reports.js";
const cpf = "52998224725",
  other = "11144477735";
const at = (time) => new Date(`2026-09-21T${time}:00-03:00`);
const make = () => ({
  config: { teacherAttendanceStart: "2026-09-21" },
  professores: [
    { id: "t", nome: "Professor Um", cpfHash: hashCpf(cpf), ativo: true },
    { id: "s", nome: "Professor Dois", cpfHash: hashCpf(other), ativo: true },
  ],
  turmas: [
    {
      id: "A",
      nome: "A",
      professorId: "t",
      professor: "Professor Um",
      horarios: [{ dia: 1, inicio: "15:00", fim: "18:00" }],
    },
    {
      id: "B",
      nome: "B",
      professorId: "t",
      professor: "Professor Um",
      horarios: [{ dia: 1, inicio: "18:30", fim: "21:30" }],
    },
  ],
  teacherAttendance: [],
  teacherSubstitutions: [],
});
const punch = (store, time, extra = {}) =>
  registerTeacherAttendance(
    store,
    { cpf, requestId: crypto.randomUUID(), ...extra },
    at(time),
  );
test("two separate periods receive their own entry and exit", () => {
  const s = make();
  for (const [time, message] of [
    ["15:00", "Entrada registrada!"],
    ["18:00", "Saída registrada!"],
    ["18:30", "Entrada registrada!"],
    ["21:30", "Saída registrada!"],
  ])
    assert.equal(punch(s, time).body.message, message);
  assert.equal(s.teacherAttendance.length, 2);
  for (const r of s.teacherAttendance) assert.equal(r.status, "Concluído");
});
test("entry repeats, idempotent retries, and completed periods do not duplicate points", () => {
  const s = make(),
    requestId = crypto.randomUUID();
  assert.equal(punch(s, "15:00", { requestId }).changed, true);
  assert.equal(punch(s, "15:00").body.state, "already");
  assert.equal(punch(s, "17:50", { requestId }).body.state, "already");
  assert.equal(s.teacherAttendance[0].saida, null);
  assert.equal(punch(s, "17:50").body.message, "Saída registrada!");
  assert.equal(punch(s, "17:51").body.state, "already");
  assert.equal(s.teacherAttendance.length, 1);
});
test("minimum interval prevents accidental checkout even near class end", () => {
  const s = make();
  punch(s, "17:50");
  assert.equal(punch(s, "17:51").body.state, "already");
  assert.equal(s.teacherAttendance[0].saida, null);
});
test("missing exit from first class does not turn entry to next class into exit", () => {
  const s = make();
  punch(s, "15:00");
  punch(s, "18:30");
  assert.equal(s.teacherAttendance.length, 2);
  assert.equal(s.teacherAttendance[0].saida, null);
});
test("ambiguous windows ask for a period and reject a forged selection", () => {
  const s = make();
  punch(s, "15:00");
  assert.equal(punch(s, "18:10").body.state, "choose");
  assert.equal(punch(s, "18:10", { sessionId: "fake" }).status, 409);
  assert.equal(
    punch(s, "18:10", { sessionId: "A_2026-09-21_1500" }).body.message,
    "Saída registrada!",
  );
});
test("substitutes require an assigned lesson and preserve the scheduled teacher", () => {
  const s = make();
  assert.equal(punch(s, "15:00", { cpf: other }).status, 422);
  s.teacherSubstitutions.push({
    sessionId: "A_2026-09-21_1500",
    professorId: "s",
  });
  const r = punch(s, "15:00", { cpf: other }).body.record;
  assert.equal(r.professorPrevistoId, "t");
  assert.equal(r.professorId, "s");
  assert.equal(r.tipoProfessor, "Substituto");
  assert.equal(s.turmas[0].professorId, "t");
  assert.notEqual(punch(s, "15:00").body.state, "registered");
});
test("invalid, unknown and inactive CPFs never write records", () => {
  const s = make();
  assert.equal(punch(s, "15:00", { cpf: "11111111111" }).status, 422);
  assert.equal(punch(s, "15:00", { cpf: "12345678909" }).status, 404);
  s.professores[0].ativo = false;
  assert.equal(punch(s, "15:00").status, 404);
  assert.equal(s.teacherAttendance.length, 0);
});
test("formatted CPF matches same teacher; tolerance is configurable", () => {
  const s = make();
  assert.match(punch(s, "14:29").body.error, /15:00/);
  assert.equal(punch(s, "14:30", { cpf: "529.982.247-25" }).changed, true);
  const strict = make();
  strict.config.teacherAttendanceSettings = { entryBefore: 10 };
  assert.equal(punch(strict, "14:30").status, 422);
});
test("after a class ends, exit without entry is rejected", () => {
  const s = make();
  s.turmas.pop();
  assert.match(punch(s, "18:01").body.error, /Não existe entrada/);
});
test("closed, canceled and wrong-day lessons never create attendance", () => {
  for (const change of [
    (t) => (t.ativa = false),
    (t) => (t.fim = "2026-09-20"),
    (t) => (t.inicio = "2026-09-22"),
    (t) => (t.horarios[0].dia = 2),
    (t) => (t.canceladas = ["A_2026-09-21_1500"]),
  ]) {
    const s = make();
    s.turmas.pop();
    change(s.turmas[0]);
    assert.equal(punch(s, "15:00").status, 422);
    assert.equal(s.teacherAttendance.length, 0);
  }
});
test("recorded times remain valid when a class schedule changes", () => {
  const s = make();
  punch(s, "15:00");
  s.turmas[0].horarios[0].fim = "16:00";
  assert.equal(punch(s, "18:00").body.message, "Saída registrada!");
  assert.equal(s.teacherAttendance[0].horarioFimPrevisto, "18:00");
});
test("report calculates objective minutes and leaves unclosed periods blank", async () => {
  const s = make();
  s.turmas = [
    {
      id: "A",
      nome: "=UNTRUSTED()",
      professorId: "t",
      professor: "Professor Um",
      horarios: [{ dia: 1, inicio: "19:00", fim: "21:00" }],
    },
  ];
  punch(s, "19:05");
  let report = buildTeacherReport(
    s,
    { from: "2026-09-21", to: "2026-09-21" },
    at("20:50"),
  );
  assert.equal(report.rows[0].minutosRealizados, null);
  punch(s, "20:50");
  report = buildTeacherReport(
    s,
    { from: "2026-09-21", to: "2026-09-21" },
    at("22:30"),
  );
  assert.equal(report.rows[0].minutosPrevistos, 120);
  assert.equal(report.rows[0].minutosRealizados, 105);
  assert.equal(report.rows[0].diferencaMinutos, -15);
  const buffer = await exportTeacherWorkbook(s, report);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.getWorksheet("REGISTROS");
  assert.equal(sheet.getCell("L2").value, -15);
  assert.equal(sheet.getCell("E2").type, ExcelJS.ValueType.String);
  assert.equal(sheet.views[0].ySplit, 1);
  assert.ok(sheet.autoFilter);
  assert.equal(wb.worksheets.length, 6);
  assert.ok(!JSON.stringify(report).includes("cpfHash"));
});
test("no retroactive absences before feature activation; unfinished lessons remain pending", () => {
  const s = make();
  delete s.config.teacherAttendanceStart;
  assert.equal(
    buildTeacherReport(s, { from: "2026-09-21", to: "2026-09-21" }, at("23:00"))
      .rows.length,
    0,
  );
  s.config.teacherAttendanceStart = "2026-09-21";
  assert.ok(
    buildTeacherReport(
      s,
      { from: "2026-09-21", to: "2026-09-21" },
      at("23:00"),
    ).rows.every((r) => r.status === "Sem registro"),
  );
});
test("invalid settings and unbounded export periods are rejected", () => {
  assert.throws(() => validateTeacherSettings({ entryBefore: NaN }));
  assert.throws(() => validateTeacherSettings({ duplicateMinutes: 0 }));
  assert.throws(() =>
    buildTeacherReport(make(), { from: "2026-01-01", to: "2026-12-31" }),
  );
});
