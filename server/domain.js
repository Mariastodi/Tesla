import crypto from "node:crypto";
import { salt } from "./config.js";
export const onlyDigits = (value) => String(value || "").replace(/\D/g, "");
export const now = () =>
  process.env.NODE_ENV === "test" && process.env.TEST_NOW
    ? new Date(process.env.TEST_NOW)
    : new Date();
export const dateKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const minutes = (value) => {
  const [hour, minute] = String(value || "0:0")
    .split(":")
    .map(Number);
  return hour * 60 + (minute || 0);
};
export const legacyHashCpf = (cpf) =>
  process.env.LEGACY_CPF_SALT
    ? crypto
        .createHmac("sha256", process.env.LEGACY_CPF_SALT)
        .update(onlyDigits(cpf))
        .digest("hex")
    : null;
export const matchesCpf = (item, cpf) =>
  Boolean(item.cpfHash) &&
  (item.cpfHash === hashCpf(cpf) || item.cpfHash === legacyHashCpf(cpf));
export const hashCpf = (cpf) =>
  crypto.createHmac("sha256", salt).update(onlyDigits(cpf)).digest("hex");
export const validCpf = (cpf) => {
  const digits = onlyDigits(cpf);
  if (digits.length !== 11 || /^([0-9])\1{10}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < 9; index += 1)
    sum += Number(digits[index]) * (10 - index);
  let check = (sum * 10) % 11;
  if (check === 10) check = 0;
  if (check !== Number(digits[9])) return false;
  sum = 0;
  for (let index = 0; index < 10; index += 1)
    sum += Number(digits[index]) * (11 - index);
  check = (sum * 10) % 11;
  if (check === 10) check = 0;
  return check === Number(digits[10]);
};
export const publicStudent = (student) => {
  const { cpfHash, ...safe } = student;
  return { ...safe, vinculo: student.vinculo || "" };
};
export const publicKioskStudent = (student) => ({
  id: student.id,
  nome: student.nome,
});
export const publicTeacher = (teacher) => {
  const { cpfHash, ...safe } = teacher;
  return { ...safe, cpfStatus: cpfHash ? "verificado" : "pendente" };
};
export const slug = (value) =>
  String(value || "professor")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
export const teachersFromClasses = (classes) => [
  ...new Map(
    classes
      .map((item) => [
        String(item.professor || "")
          .trim()
          .toLocaleLowerCase(),
        String(item.professor || "").trim(),
      ])
      .filter(([id, name]) => id && name)
      .map(([id, name]) => [
        `prof-${slug(name)}`,
        { id: `prof-${slug(name)}`, nome: name, cpfHash: "", ativo: true },
      ]),
  ).values(),
];
export const connectClassesToTeachers = (classes, teachers) =>
  classes.map((item) => ({
    ...item,
    professorId:
      item.professorId ||
      teachers.find(
        (teacher) =>
          teacher.nome.toLocaleLowerCase() ===
          String(item.professor || "")
            .trim()
            .toLocaleLowerCase(),
      )?.id ||
      "",
  }));
export const sessionFrom = (classItem, schedule, date = dateKey(now())) => ({
  id: `${classItem.id}_${date}_${schedule.inicio.replace(":", "")}`,
  turmaId: classItem.id,
  data: date,
  inicio: schedule.inicio,
  fim: schedule.fim,
  turma: classItem,
});
export const openSessions = (store) => {
  const current = now();
  const weekday = current.getDay();
  const currentMinutes = current.getHours() * 60 + current.getMinutes();
  return store.turmas.flatMap((classItem) => {
    if (classItem.ativa === false || !classItem.horarios?.length) return [];
    if (classItem.inicio && classItem.inicio > dateKey(current)) return [];
    if (classItem.fim && classItem.fim < dateKey(current)) return [];
    return classItem.horarios
      .filter(
        (schedule) =>
          Number(schedule.dia) === weekday &&
          currentMinutes >=
            minutes(schedule.inicio) - Number(store.config.tolAntes ?? 30) &&
          currentMinutes <=
            minutes(schedule.fim) + Number(store.config.tolDepois ?? 60) &&
          !(classItem.canceladas || []).includes(
            `${classItem.id}_${dateKey(current)}_${schedule.inicio.replace(":", "")}`,
          ),
      )
      .map((schedule) => sessionFrom(classItem, schedule));
  });
};
export const completedSessions = (store, classItem) => {
  if (!classItem.inicio) return [];
  const result = [];
  const start = new Date(`${classItem.inicio}T00:00:00`);
  const end = new Date();
  const minimum = store.config.inicioControle
    ? new Date(`${store.config.inicioControle}T00:00:00`)
    : null;
  for (
    const date = new Date(start);
    date <= end;
    date.setDate(date.getDate() + 1)
  ) {
    const currentDate = dateKey(date);
    for (const schedule of classItem.horarios || []) {
      if (date.getDay() !== Number(schedule.dia)) continue;
      const session = sessionFrom(classItem, schedule, currentDate);
      const finish = new Date(`${currentDate}T${schedule.fim}:00`);
      if (
        (classItem.fim && currentDate > classItem.fim) ||
        finish > end ||
        (minimum && date < minimum) ||
        (classItem.canceladas || []).includes(session.id)
      )
        continue;
      result.push(session);
    }
  }
  return result;
};
export const attendanceReport = (store) =>
  store.alunos
    .filter((student) => student.ativo !== false)
    .map((student) => {
      const sessions = store.turmas
        .filter((classItem) => (student.turmaIds || []).includes(classItem.id))
        .flatMap((classItem) => completedSessions(store, classItem))
        .filter((session) => !student.desde || session.data >= student.desde);
      const present = new Set(
        store.checkins
          .filter((checkin) => checkin.alunoId === student.id)
          .map((checkin) => checkin.sessaoId),
      );
      const presencas = sessions.filter((session) =>
        present.has(session.id),
      ).length;
      const faltas = Math.max(0, sessions.length - presencas);
      return {
        alunoId: student.id,
        nome: student.nome,
        total: sessions.length,
        presencas,
        faltas,
        percentual: sessions.length
          ? Math.round((presencas * 100) / sessions.length)
          : 100,
      };
    });
