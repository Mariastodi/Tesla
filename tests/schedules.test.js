import test from "node:test";
import assert from "node:assert/strict";
import { validatedSchedules } from "../server/schedules.js";
test("grade aceita dois períodos e formato legado, sem sobreposição", () => {
  const horarios = [
    { dia: 1, inicio: "08:00", fim: "10:00" },
    { dia: 1, inicio: "10:00", fim: "12:00" },
  ];
  assert.deepEqual(validatedSchedules({ horarios }), horarios);
  assert.deepEqual(validatedSchedules(horarios[0]), [horarios[0]]);
  assert.equal(
    validatedSchedules({
      horarios: [...horarios, { dia: 1, inicio: "09:00", fim: "11:00" }],
    }),
    null,
  );
  for (const horarios of [
    [],
    [null],
    [{ dia: 9, inicio: "08:00", fim: "10:00" }],
    [{ dia: 1, inicio: "22:00", fim: "06:00" }],
  ])
    assert.equal(validatedSchedules({ horarios }), null);
});
