import { minutes } from "./domain.js";
export function validatedSchedules(body) {
  const rows = body.horarios ?? [
    { dia: body.dia, inicio: body.inicio, fim: body.fim },
  ];
  if (!Array.isArray(rows) || !rows.length || rows.length > 30) return null;
  const result = [];
  for (const h of rows) {
    if (
      !h ||
      !Number.isInteger(Number(h.dia)) ||
      Number(h.dia) < 0 ||
      Number(h.dia) > 6 ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(h.inicio) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(h.fim) ||
      minutes(h.fim) <= minutes(h.inicio)
    )
      return null;
    if (
      result.some(
        (previous) =>
          previous.dia === Number(h.dia) &&
          minutes(h.inicio) < minutes(previous.fim) &&
          minutes(h.fim) > minutes(previous.inicio),
      )
    )
      return null;
    result.push({ dia: Number(h.dia), inicio: h.inicio, fim: h.fim });
  }
  return result;
}
