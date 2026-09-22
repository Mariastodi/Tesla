import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const pin = "test-only-admin-secret";
const salt = "test-only-salt-32-characters-or-more";
const cpf = "52998224725";
const cpf2 = "11144477735";
const cpf3 = "12345678909";
const hash = (value) =>
  crypto.createHmac("sha256", salt).update(value).digest("hex");
let directory, child, cookie, base;
async function request(
  route,
  body,
  headers = {},
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
    headers: response.headers,
  };
}
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "tesla-test-"));
  const turmas = [
    {
      id: "MARK",
      nome: "Marketing",
      curso: "Marketing",
      inicio: "2026-09-01",
      fim: "2026-12-01",
      ativa: true,
      horarios: [{ dia: 1, inicio: "19:00", fim: "21:00" }],
    },
    {
      id: "OTHER",
      nome: "Outra turma",
      ativa: true,
      horarios: [{ dia: 1, inicio: "19:00", fim: "21:00" }],
    },
    {
      id: "CLOSED",
      nome: "Encerrada",
      fim: "2026-09-20",
      ativa: true,
      horarios: [{ dia: 1, inicio: "19:00", fim: "21:00" }],
    },
  ];
  await fs.writeFile(
    path.join(directory, "runtime.json"),
    JSON.stringify({
      config: {
        escola: "Escola de teste",
        tolAntes: 0,
        tolDepois: 0,
        minimo: 75,
      },
      turmas,
      professores: [],
      alunos: [
        {
          id: "a",
          nome: "Aluno Fictício Um",
          tel: "PRIVATE_PHONE",
          cpfHash: hash(cpf),
          ativo: true,
          turmaIds: ["MARK"],
        },
        {
          id: "b",
          nome: "Aluno Fictício Dois",
          cpfHash: "",
          ativo: true,
          turmaIds: ["MARK"],
        },
        {
          id: "c",
          nome: "Aluno Fictício Três",
          cpfHash: "",
          ativo: true,
          turmaIds: ["OTHER"],
        },
        {
          id: "d",
          nome: "Aluno Inativo",
          cpfHash: "",
          ativo: false,
          turmaIds: ["MARK"],
        },
      ],
      checkins: [],
    }),
  );
  child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: "0",
      NODE_ENV: "test",
      TEST_NOW: "2026-09-21T22:00:00Z",
      TZ: "UTC",
      DATA_DIR: directory,
      DATABASE_URL: "",
      ADMIN_PIN: pin,
      CPF_SALT: salt,
      REQUIRE_DEVICE: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const address = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Server startup timed out")),
      10000,
    );
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const found = output.match(/http:\/\/localhost:(\d+)/);
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited: ${code}`));
    });
  });
  base = `http://127.0.0.1:${address}`;
});
after(async () => {
  if (child) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test("public bootstrap is minimal, does not enumerate students, and is not cached", async () => {
  const r = await request("/api/bootstrap");
  assert.equal(r.status, 200);
  assert.equal(r.body.deviceReady, false);
  assert.equal(r.body.alunos, undefined);
  assert.equal(r.headers.get("cache-control"), "no-store");
});
test("unactivated device cannot read students or register attendance", async () => {
  assert.equal((await request("/api/kiosk/roster?q=Aluno")).status, 401);
  assert.equal(
    (
      await request("/api/kiosk/checkin", {
        cpf,
        sessionId: "MARK_2026-09-21_1900",
      })
    ).status,
    401,
  );
});
test("admin endpoints reject missing or wrong credentials", async () => {
  assert.equal((await request("/api/admin/overview")).status, 401);
  assert.equal(
    (
      await request("/api/admin/overview", undefined, {
        "x-admin-pin": "wrong",
      })
    ).status,
    401,
  );
});
test("device activation creates an HttpOnly SameSite cookie", async () => {
  const r = await request("/api/device/activate", {}, { "x-admin-pin": pin });
  assert.equal(r.status, 200);
  const header = r.headers.get("set-cookie");
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  cookie = header.split(";")[0];
  assert.equal((await request("/api/bootstrap")).body.deviceReady, true);
});
test("repeated digits and incorrect check digits fail CPF validation", async () => {
  for (const value of ["11111111111", "123", "52998224724"])
    assert.equal(
      (await request("/api/kiosk/identify", { cpf: value })).status,
      422,
    );
});
test("unrecognized CPF does not disclose roster or class data", async () => {
  const r = await request("/api/kiosk/identify", { cpf: cpf2 });
  assert.deepEqual(r.body, { state: "first-access" });
});
test("search returns only unlinked active students with minimal fields", async () => {
  assert.deepEqual((await request("/api/kiosk/roster?q=Al")).body.students, []);
  const r = await request("/api/kiosk/roster?q=Aluno");
  assert.equal(r.body.students.length, 2);
  for (const student of r.body.students)
    assert.deepEqual(Object.keys(student).sort(), ["id", "nome"]);
});
test("identification uses Fortaleza timezone even on a UTC host and hides private fields", async () => {
  const r = await request("/api/kiosk/identify", { cpf });
  assert.equal(r.body.sessions.length, 1);
  assert.equal(r.body.sessions[0].inicio, "19:00");
  assert.deepEqual(r.body.student, { id: "a", nome: "Aluno Fictício Um" });
});
test("attendance cannot be registered for another class, future date, or closed class", async () => {
  for (const id of [
    "OTHER_2026-09-21_1900",
    "MARK_2026-09-22_1900",
    "CLOSED_2026-09-21_1900",
  ])
    assert.equal(
      (await request("/api/kiosk/checkin", { cpf, sessionId: id })).status,
      404,
    );
});
test("concurrent attendance is idempotent and persists exactly once", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      request("/api/kiosk/checkin", { cpf, sessionId: "MARK_2026-09-21_1900" }),
    ),
  );
  assert.equal(results.filter((r) => r.body.state === "registered").length, 1);
  assert.equal(results.filter((r) => r.body.state === "already").length, 7);
  const store = JSON.parse(
    await fs.readFile(path.join(directory, "runtime.json")),
  );
  assert.equal(store.checkins.length, 1);
  assert.equal(store.checkins[0].hora, "19:00");
});
test("concurrent first access enforces one student per CPF", async () => {
  const results = await Promise.all(
    ["b", "c"].map((alunoId) =>
      request("/api/kiosk/link", { cpf: cpf2, alunoId }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  const store = JSON.parse(
    await fs.readFile(path.join(directory, "runtime.json")),
  );
  assert.equal(store.alunos.filter((a) => a.cpfHash === hash(cpf2)).length, 1);
  assert.ok(!JSON.stringify(store).includes(cpf2));
});
test("claim endpoint rejects a CPF already linked to someone else", async () => {
  const store = JSON.parse(
    await fs.readFile(path.join(directory, "runtime.json")),
  );
  const pending = store.alunos.find(
    (s) => s.ativo && s.id !== "a" && !s.cpfHash,
  );
  const r = await request("/api/kiosk/claim", {
    cpf,
    alunoId: pending.id,
    sessionId: `${pending.turmaIds[0]}_2026-09-21_1900`,
  });
  assert.equal(r.status, 409);
});
test("inactive students cannot self-link", async () =>
  assert.equal(
    (await request("/api/kiosk/link", { cpf: cpf3, alunoId: "d" })).status,
    409,
  ));
test("first access retains class membership", async () => {
  const store = JSON.parse(
    await fs.readFile(path.join(directory, "runtime.json")),
  );
  const linked = store.alunos.find((s) => s.cpfHash === hash(cpf2));
  const result = await request("/api/kiosk/identify", { cpf: cpf2 });
  assert.equal(result.body.sessions[0].turmaId, linked.turmaIds[0]);
});
test("cross-site mutation is rejected", async () =>
  assert.equal(
    (
      await request(
        "/api/kiosk/link",
        { cpf: cpf3, alunoId: "d" },
        { "Sec-Fetch-Site": "cross-site" },
      )
    ).status,
    403,
  ));
test("invalid JSON returns controlled error, service continues", async () => {
  const r = await fetch(base + "/api/kiosk/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(r.status, 400);
  assert.equal((await request("/health")).status, 200);
});
test("unknown API endpoints are JSON 404, not the SPA", async () =>
  assert.equal((await request("/api/nonexistent")).status, 404));
test("private files are never served as static content", async () => {
  for (const file of ["/dados/alunos.json", "/.env", "/server.js"]) {
    const r = await fetch(base + file);
    const text = await r.text();
    assert.ok(!text.includes("PRIVATE_PHONE"));
    assert.ok(!text.includes(salt));
    assert.ok(!text.includes("cpfHash"));
  }
});
test("admin still works after more than twelve successful requests", async () => {
  for (let i = 0; i < 15; i++)
    assert.equal(
      (await request("/api/admin/overview", undefined, { "x-admin-pin": pin }))
        .status,
      200,
    );
});
test("initial import refuses to overwrite existing records", async () =>
  assert.equal(
    (
      await request(
        "/api/admin/import",
        { config: {}, alunos: [], turmas: [] },
        { "x-admin-pin": pin },
      )
    ).status,
    409,
  ));
test("corrupt local database fails closed without silently resetting school data", async () => {
  await fs.writeFile(path.join(directory, "runtime.json"), "corrupt-test");
  assert.equal((await request("/api/kiosk/identify", { cpf })).status, 500);
  assert.equal(
    await fs.readFile(path.join(directory, "runtime.json"), "utf8"),
    "corrupt-test",
  );
});
