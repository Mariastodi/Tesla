import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const pin = "integration-admin-secret";
const salt = "integration-teacher-salt-long-enough";

const cpf = "52998224725";
const subCpf = "11144477735";

const hash = (value) =>
  crypto
    .createHmac("sha256", salt)
    .update(value)
    .digest("hex");

let dir;
let child;
let base;
let cookie;

async function request(
  route,
  body,
  admin = false,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(base + route, {
    method,

    headers: {
      "Content-Type": "application/json",

      ...(cookie
        ? { Cookie: cookie }
        : {}),

      ...(admin
        ? { "x-admin-pin": pin }
        : {}),
    },

    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
        }),
  });

  return {
    status: response.status,
    body: await response.json().catch(() => null),
    headers: response.headers,
  };
}

async function start(time) {
  child = spawn(
    process.execPath,
    ["server.js"],
    {
      env: {
        ...process.env,

        NODE_ENV: "test",

        TEST_NOW:
          `2026-09-21T${time}:00-03:00`,

        DATABASE_URL: "",

        DATA_DIR: dir,

        PORT: "0",

        ADMIN_PIN: pin,

        ADMIN_PIN_HASH: "",

        CPF_SALT: salt,

        REQUIRE_DEVICE: "true",

        GOOGLE_APPS_SCRIPT_URL: "",

        SHEET_SYNC_INTERVAL_MS: "60000",
      },

      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );

  let stderr = "";

  child.stderr.on(
    "data",
    (s) => {
      stderr += s;
    },
  );

  const port = await new Promise(
    (resolve, reject) => {
      const timer = setTimeout(
        () => {
          reject(
            Error("startup timeout"),
          );
        },
        10000,
      );

      child.stdout.on(
        "data",
        (chunk) => {
          const match = chunk
            .toString()
            .match(/localhost:(\d+)/);

          if (match) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        },
      );

      child.once(
        "exit",
        () => {
          clearTimeout(timer);

          reject(
            Error(stderr),
          );
        },
      );
    },
  );

  base =
    `http://127.0.0.1:${port}`;
}

async function stop() {
  if (
    child &&
    child.exitCode === null
  ) {
    const done =
      new Promise((resolve) => {
        child.once(
          "exit",
          resolve,
        );
      });

    child.kill();

    await done;
  }
}

before(async () => {
  dir = await fs.mkdtemp(
    path.join(
      os.tmpdir(),
      "teacher-api-",
    ),
  );

  await fs.writeFile(
    path.join(
      dir,
      "runtime.json",
    ),

    JSON.stringify({
      config: {},

      professores: [
        {
          id: "t",
          nome: "Professor Legado",
          cpfHash: "",
          ativo: true,
        },

        {
          id: "s",
          nome: "Substituto",
          cpfHash: hash(subCpf),
          ativo: true,
        },
      ],

      turmas: [
        {
          id: "A",
          nome: "Turma A",
          professorId: "t",
          professor: "Professor Legado",

          horarios: [
            {
              dia: 1,
              inicio: "19:00",
              fim: "21:00",
            },
          ],
        },
      ],

      alunos: [],

      checkins: [],
    }),
  );

  await start("19:00");
});

after(async () => {
  await stop();

  await fs.rm(
    dir,
    {
      recursive: true,
      force: true,
    },
  );
});

test(
  "teacher endpoints require activated tablets and admin reports require credentials",
  async () => {
    assert.equal(
      (
        await request(
          "/api/kiosk/teacher-attendance",
          {
            cpf,
            requestId:
              crypto.randomUUID(),
          },
        )
      ).status,
      401,
    );

    assert.equal(
      (
        await request(
          "/api/admin/teacher-attendance",
        )
      ).status,
      401,
    );

    const active =
      await request(
        "/api/device/activate",
        {},
        true,
      );

    assert.equal(
      active.status,
      200,
    );

    cookie =
      active.headers
        .get("set-cookie")
        .split(";")[0];
  },
);

test(
  "coordinator links a legacy teacher CPF without creating duplicate teachers",
  async () => {
    const result =
      await request(
        "/api/admin/teachers/t",

        {
          nome: "Professor Legado",
          cpf: "529.982.247-25",
        },

        true,

        "PUT",
      );

    assert.equal(
      result.status,
      200,
    );

    assert.equal(
      result.body.professor.cpfStatus,
      "verificado",
    );

    assert.equal(
      result.body.professor.cpfHash,
      undefined,
    );

    assert.equal(
      (
        await request(
          "/api/admin/teachers/s",

          {
            nome: "Substituto",
            cpf,
          },

          true,

          "PUT",
        )
      ).status,
      409,
    );
  },
);

test(
  "concurrent punches persist once, retry is idempotent and survives server restart",
  async () => {
    const requestId =
      crypto.randomUUID();

    const results =
      await Promise.all(
        Array.from(
          { length: 4 },

          () =>
            request(
              "/api/kiosk/teacher-attendance",

              {
                cpf,
                requestId,
              },
            ),
        ),
      );

    assert.ok(
      results.every(
        (result) =>
          result.status === 200,
      ),
    );

    assert.equal(
      results.filter(
        (result) =>
          result.body.state ===
          "registered",
      ).length,

      1,
    );

    const report =
      await request(
        "/api/admin/teacher-attendance?from=2026-09-21&to=2026-09-21",
        undefined,
        true,
      );

    assert.equal(
      report.body.rows.length,
      1,
    );

    assert.equal(
      report.body.rows[0].saida,
      null,
    );

    await stop();

    await start("21:01");

    assert.equal(
      (
        await request(
          "/api/kiosk/teacher-attendance",

          {
            cpf,
            requestId,
          },
        )
      ).body.state,

      "already",
    );

    const exit =
      await request(
        "/api/kiosk/teacher-attendance",

        {
          cpf,
          requestId:
            crypto.randomUUID(),
        },
      );

    assert.equal(
      exit.body.message,
      "Saída registrada!",
    );

    const stored =
      JSON.parse(
        await fs.readFile(
          path.join(
            dir,
            "runtime.json",
          ),
          "utf8",
        ),
      );

    assert.equal(
      stored.teacherAttendance.length,
      1,
    );

    assert.ok(
      stored.teacherAttendance[0]
        .saida,
    );
  },
);

test(
  "substitution cannot overwrite an already recorded class",
  async () => {
    const result =
      await request(
        "/api/admin/teacher-substitutions",

        {
          date: "2026-09-21",
          sessionId:
            "A_2026-09-21_1900",
          professorId: "s",
        },

        true,
      );

    assert.equal(
      result.status,
      409,
    );
  },
);

test(
  "authenticated XLSX export is a workbook and unconfigured sync reports its state",
  async () => {
    const response =
      await fetch(
        base +
          "/api/admin/teacher-attendance.xlsx?from=2026-09-21&to=2026-09-21",

        {
          headers: {
            "x-admin-pin": pin,
          },
        },
      );

    assert.equal(
      response.status,
      200,
    );

    assert.match(
      response.headers.get(
        "content-type",
      ),
      /spreadsheetml/,
    );

    assert.equal(
      Buffer.from(
        await response.arrayBuffer(),
      )
        .subarray(0, 2)
        .toString(),

      "PK",
    );

    const sync =
      await request(
        "/api/admin/teacher-sync",
        {},
        true,
      );

    assert.equal(
      sync.body.state,
      "unconfigured",
    );
  },
);