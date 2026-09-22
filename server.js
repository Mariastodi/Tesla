import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
process.env.TZ = "America/Fortaleza";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, "dados"),
);
const runtimeFile = path.join(dataDir, "runtime.json");
const salt = process.env.CPF_SALT || "presenca-tesla-local-salt";
const adminPin = process.env.ADMIN_PIN || "";
const production = process.env.NODE_ENV === "production";
if (
  production &&
  (!process.env.DATABASE_URL || salt.length < 32 || adminPin.length < 12)
)
  throw new Error(
    "Produção exige DATABASE_URL, CPF_SALT (32 caracteres) e ADMIN_PIN (12 caracteres).",
  );
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
  : null;
const transaction = new AsyncLocalStorage();
const database = () => transaction.getStore() || pool;
let localQueue = Promise.resolve();
// Every API read-modify-write is isolated, including across server instances.
for (const method of ["get", "post", "put", "delete"]) {
  const register = app[method].bind(app);
  app[method] = (route, ...handlers) => {
    if (!handlers.length) return register(route);
    const handler = handlers.pop();
    return register(route, ...handlers, (req, res, next) => {
      const execute = async () => {
        let client;
        const originalJson = res.json.bind(res);
        try {
          await repositoryReady;
          if (pool && String(route).startsWith("/api/")) {
            client = await pool.connect();
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock(74823901)");
          }
          // Delay JSON responses until the transaction is committed.
          const json = res.json.bind(res);
          let payload;
          let responded = false;
          res.json = (value) => {
            payload = value;
            responded = true;
            return res;
          };
          await transaction.run(client, () => handler(req, res, next));
          if (client) await client.query("COMMIT");
          res.json = json;
          if (responded) json(payload);
        } catch (error) {
          if (client) await client.query("ROLLBACK").catch(() => {});
          res.json = originalJson;
          next(error);
        } finally {
          client?.release();
        }
      };
      if (pool) execute();
      else {
        localQueue = localQueue.then(execute, execute);
      }
    });
  };
}
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 0));

app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:"],
        scriptSrc: ["'self'"],
      },
    },
  }),
);
app.use(express.json({ limit: "256kb" }));
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.headers["sec-fetch-site"] === "cross-site")
    return res.status(403).json({ error: "Origem não autorizada." });
  if (!["GET", "HEAD"].includes(req.method) && !req.is("application/json"))
    return res.status(415).json({ error: "Envie JSON." });
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const kioskLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  message: { error: "Muitas tentativas. Aguarde um minuto." },
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  skipSuccessfulRequests: true,
  message: { error: "Muitas tentativas de acesso. Aguarde 15 minutos." },
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

const onlyDigits = (value) => String(value || "").replace(/\D/g, "");
const now = () =>
  process.env.NODE_ENV === "test" && process.env.TEST_NOW
    ? new Date(process.env.TEST_NOW)
    : new Date();
const dateKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const minutes = (value) => {
  const [hour, minute] = String(value || "0:0")
    .split(":")
    .map(Number);
  return hour * 60 + (minute || 0);
};
const legacyHashCpf = (cpf) =>
  process.env.LEGACY_CPF_SALT
    ? crypto
        .createHmac("sha256", process.env.LEGACY_CPF_SALT)
        .update(onlyDigits(cpf))
        .digest("hex")
    : null;
const matchesCpf = (item, cpf) =>
  Boolean(item.cpfHash) &&
  (item.cpfHash === hashCpf(cpf) || item.cpfHash === legacyHashCpf(cpf));
const hashCpf = (cpf) =>
  crypto.createHmac("sha256", salt).update(onlyDigits(cpf)).digest("hex");
const validCpf = (cpf) => {
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
const publicStudent = (student) => {
  const { cpfHash, ...safe } = student;
  return { ...safe, vinculo: student.vinculo || "" };
};
const publicKioskStudent = (student) => ({
  id: student.id,
  nome: student.nome,
});
const publicTeacher = (teacher) => {
  const { cpfHash, ...safe } = teacher;
  return { ...safe, cpfStatus: cpfHash ? "verificado" : "pendente" };
};
const slug = (value) =>
  String(value || "professor")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const teachersFromClasses = (classes) => [
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
const connectClassesToTeachers = (classes, teachers) =>
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
const sessionFrom = (classItem, schedule, date = dateKey(now())) => ({
  id: `${classItem.id}_${date}_${schedule.inicio.replace(":", "")}`,
  turmaId: classItem.id,
  data: date,
  inicio: schedule.inicio,
  fim: schedule.fim,
  turma: classItem,
});
const openSessions = (store) => {
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
const sessionById = (store, id) => {
  for (const classItem of store.turmas) {
    for (const schedule of classItem.horarios || []) {
      const session = sessionFrom(
        classItem,
        schedule,
        String(id).split("_")[1],
      );
      if (session.id === id) return session;
    }
  }
  return null;
};
const completedSessions = (store, classItem) => {
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
const attendanceReport = (store) =>
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

async function readSeed() {
  if (production)
    return {
      config: {
        escola: "Instituto Tecnológico Tesla",
        minimo: 75,
        tolAntes: 30,
        tolDepois: 60,
      },
      turmas: [],
      professores: [],
      alunos: [],
      checkins: [],
    };
  const [config, classes, students] = await Promise.all([
    fs
      .readFile(path.join(dataDir, "config.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT")
          return {
            escola: "Instituto Tecnológico Tesla",
            minimo: 75,
            tolAntes: 30,
            tolDepois: 60,
          };
        throw error;
      }),
    fs
      .readFile(path.join(dataDir, "turmas.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      }),
    fs
      .readFile(path.join(dataDir, "alunos.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      }),
  ]);
  const rawClasses = Object.entries(classes).map(([id, value]) => ({
    id,
    ...value,
  }));
  const professores = teachersFromClasses(rawClasses);
  return {
    config: { ...config, pin: "" },
    turmas: connectClassesToTeachers(rawClasses, professores),
    professores,
    alunos: Object.entries(students).map(([id, value]) => ({ id, ...value })),
    checkins: [],
  };
}

async function readFileStore() {
  try {
    const store = JSON.parse(await fs.readFile(runtimeFile, "utf8"));
    if (!store.professores)
      store.professores = teachersFromClasses(store.turmas);
    store.turmas = connectClassesToTeachers(store.turmas, store.professores);
    return store;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const seed = await readSeed();
    await writeFileStore(seed);
    return seed;
  }
}
async function writeFileStore(store) {
  await fs.mkdir(dataDir, { recursive: true });
  const temporary = `${runtimeFile}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
  await fs.rename(temporary, runtimeFile);
  return store;
}

async function setupPostgres() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS app_config (id integer primary key, data jsonb not null); CREATE TABLE IF NOT EXISTS classes (id text primary key, data jsonb not null); CREATE TABLE IF NOT EXISTS teachers (id text primary key, data jsonb not null); CREATE TABLE IF NOT EXISTS students (id text primary key, data jsonb not null); CREATE TABLE IF NOT EXISTS checkins (id text primary key, data jsonb not null, created_at timestamptz not null default now())`,
  );
  const count = await pool.query(
    "SELECT count(*)::int AS count FROM app_config",
  );
  if (count.rows[0].count === 0) {
    const seed = await readSeed();
    await pool.query("INSERT INTO app_config (id, data) VALUES (1, $1)", [
      seed.config,
    ]);
    for (const item of seed.turmas)
      await pool.query("INSERT INTO classes (id, data) VALUES ($1, $2)", [
        item.id,
        item,
      ]);
    for (const item of seed.professores)
      await pool.query("INSERT INTO teachers (id, data) VALUES ($1, $2)", [
        item.id,
        item,
      ]);
    for (const item of seed.alunos)
      await pool.query("INSERT INTO students (id, data) VALUES ($1, $2)", [
        item.id,
        item,
      ]);
  }
}
async function readStore() {
  if (!pool) return readFileStore();
  const [config, classes, teachers, students, checkins] = await Promise.all([
    database().query("SELECT data FROM app_config WHERE id = 1"),
    database().query("SELECT id, data FROM classes"),
    database().query("SELECT id, data FROM teachers"),
    database().query("SELECT id, data FROM students"),
    database().query("SELECT data FROM checkins ORDER BY created_at DESC"),
  ]);
  const rawClasses = classes.rows.map((row) => row.data);
  const professores = teachers.rows.length
    ? teachers.rows.map((row) => row.data)
    : teachersFromClasses(rawClasses);
  return {
    config: config.rows[0]?.data || {},
    turmas: connectClassesToTeachers(rawClasses, professores),
    professores,
    alunos: students.rows.map((row) => row.data),
    checkins: checkins.rows.map((row) => row.data),
  };
}
async function writeStore(store) {
  if (!pool) return writeFileStore(store);
  const client = database();
  try {
    await client.query("UPDATE app_config SET data = $1 WHERE id = 1", [
      store.config,
    ]);
    await client.query("DELETE FROM classes WHERE NOT (id = ANY($1::text[]))", [
      store.turmas.map((item) => item.id),
    ]);
    for (const item of store.turmas)
      await client.query(
        "INSERT INTO classes (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
        [item.id, item],
      );
    for (const item of store.professores || [])
      await client.query(
        "INSERT INTO teachers (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
        [item.id, item],
      );
    for (const item of store.alunos)
      await client.query(
        "INSERT INTO students (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
        [item.id, item],
      );
    return store;
  } catch (error) {
    throw error;
  }
}
async function addCheckin(store, checkin) {
  if (store.checkins.some((item) => item.id === checkin.id))
    return {
      created: false,
      checkin: store.checkins.find((item) => item.id === checkin.id),
    };
  store.checkins.unshift(checkin);
  if (pool)
    await database().query("INSERT INTO checkins (id, data) VALUES ($1, $2)", [
      checkin.id,
      checkin,
    ]);
  else await writeFileStore(store);
  return { created: true, checkin };
}

const repositoryReady = pool ? setupPostgres() : Promise.resolve();
const sameSecret = (provided, expected) => {
  const received = Buffer.from(String(provided || ""));
  const stored = Buffer.from(String(expected || ""));
  return (
    received.length === stored.length &&
    crypto.timingSafeEqual(received, stored)
  );
};
const requireAdmin = (req, res, next) => {
  if (adminPin && sameSecret(req.headers["x-admin-pin"], adminPin))
    return next();
  return res
    .status(401)
    .json({ error: "Acesso da coordenação não autorizado." });
};

const deviceKey = process.env.DEVICE_SECRET || salt;
const signDevice = (value) =>
  crypto.createHmac("sha256", deviceKey).update(value).digest("hex");
const deviceEnabled = (req) => {
  if (!production && process.env.REQUIRE_DEVICE !== "true") return true;
  const cookie =
    String(req.headers.cookie || "")
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("tesla_device="))
      ?.slice(13) || "";
  const [expires, signature] = cookie.split(".");
  return (
    Number(expires) > Date.now() && sameSecret(signature, signDevice(expires))
  );
};
app.post(
  "/api/device/activate",
  adminLimiter,
  requireAdmin,
  async (_req, res) => {
    const expires = String(Date.now() + 30 * 86400000);
    res.cookie("tesla_device", `${expires}.${signDevice(expires)}`, {
      httpOnly: true,
      secure: production,
      sameSite: "strict",
      maxAge: 30 * 86400000,
      path: "/api",
    });
    res.json({ ok: true });
  },
);
app.use("/api/kiosk", (req, res, next) =>
  deviceEnabled(req)
    ? next()
    : res
        .status(401)
        .json({ error: "Este tablet precisa ser ativado pela coordenação." }),
);

app.get("/health", async (_req, res) => {
  try {
    await repositoryReady;
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
app.get("/api/bootstrap", async (req, res) => {
  try {
    const store = await readStore();
    res.json({
      deviceReady: deviceEnabled(req),
      config: {
        escola: store.config.escola,
        minimo: store.config.minimo,
        tolAntes: store.config.tolAntes,
        tolDepois: store.config.tolDepois,
        inicioControle: store.config.inicioControle,
      },
      now: now().toISOString(),
    });
  } catch {
    res.status(500).json({ error: "Não foi possível carregar o sistema." });
  }
});
app.post("/api/kiosk/identify", kioskLimiter, async (req, res) => {
  const cpf = onlyDigits(req.body.cpf);
  if (!validCpf(cpf)) return res.status(422).json({ error: "CPF inválido." });
  const store = await readStore();
  const cpfHash = hashCpf(cpf);
  const student = store.alunos.find(
    (item) => matchesCpf(item, cpf) && item.ativo !== false,
  );
  const sessions = openSessions(store);
  if (!student) {
    return res.json({ state: "first-access" });
  }
  if (student.cpfHash !== cpfHash) {
    student.cpfHash = cpfHash;
    await writeStore(store);
  }
  const studentSessions = sessions.filter((session) =>
    (student.turmaIds || []).includes(session.turmaId),
  );
  return res.json({
    state: "identified",
    student: publicKioskStudent(student),
    sessions: studentSessions,
  });
});
app.get("/api/kiosk/roster", kioskLimiter, async (req, res) => {
  const store = await readStore();
  const query = String(req.query.q || "")
    .trim()
    .toLocaleLowerCase();
  if (query.length < 3 || query.length > 100) return res.json({ students: [] });
  res.json({
    students: store.alunos
      .filter(
        (item) =>
          item.ativo !== false &&
          !item.cpfHash &&
          item.nome.toLocaleLowerCase().includes(query),
      )
      .slice(0, 20)
      .map(publicKioskStudent),
  });
});
app.post("/api/kiosk/link", kioskLimiter, async (req, res) => {
  const cpf = onlyDigits(req.body.cpf);
  if (!validCpf(cpf)) return res.status(422).json({ error: "CPF inválido." });
  const store = await readStore();
  const cpfHash = hashCpf(cpf);
  const alreadyLinked = store.alunos.find((item) => matchesCpf(item, cpf));
  const student = store.alunos.find(
    (item) => item.id === req.body.alunoId && item.ativo !== false,
  );
  if (alreadyLinked)
    return res
      .status(409)
      .json({ error: "Este CPF já está vinculado a outro aluno." });
  if (!student || student.cpfHash)
    return res.status(409).json({ error: "Aluno indisponível para vínculo." });
  student.cpfHash = cpfHash;
  student.vinculo = "auto";
  student.vinculoEm = Date.now();
  await writeStore(store);
  return res.json({
    state: "linked",
    student: publicKioskStudent(student),
    sessions: openSessions(store).filter((session) =>
      (student.turmaIds || []).includes(session.turmaId),
    ),
  });
});
app.post("/api/kiosk/claim", kioskLimiter, async (req, res) => {
  const cpf = onlyDigits(req.body.cpf);
  if (!validCpf(cpf)) return res.status(422).json({ error: "CPF inválido." });
  const store = await readStore();
  const student = store.alunos.find(
    (item) => item.id === req.body.alunoId && item.ativo !== false,
  );
  const session = openSessions(store).find(
    (item) => item.id === req.body.sessionId,
  );
  if (
    !student ||
    !session ||
    !(student.turmaIds || []).includes(session.turmaId) ||
    student.cpfHash
  )
    return res.status(409).json({ error: "Vínculo indisponível." });
  if (store.alunos.some((item) => matchesCpf(item, cpf)))
    return res.status(409).json({ error: "Este CPF já possui vínculo." });
  student.cpfHash = hashCpf(cpf);
  student.vinculo = "auto";
  student.vinculoEm = Date.now();
  await writeStore(store);
  return recordAttendance(store, student, session, res);
});
async function recordAttendance(store, student, session, res) {
  const id = `${session.id}__${student.id}`;
  const result = await addCheckin(store, {
    id,
    alunoId: student.id,
    alunoNome: student.nome,
    turmaId: session.turmaId,
    sessaoId: session.id,
    data: session.data,
    inicio: session.inicio,
    hora: `${String(now().getHours()).padStart(2, "0")}:${String(now().getMinutes()).padStart(2, "0")}`,
    ts: Date.now(),
  });
  const classItem = store.turmas.find((item) => item.id === session.turmaId);
  return res.json({
    state: result.created ? "registered" : "already",
    student: publicKioskStudent(student),
    session,
    turma: classItem,
  });
}
app.post("/api/kiosk/checkin", kioskLimiter, async (req, res) => {
  const cpf = onlyDigits(req.body.cpf);
  if (!validCpf(cpf)) return res.status(422).json({ error: "CPF inválido." });
  const store = await readStore();
  const student = store.alunos.find(
    (item) => matchesCpf(item, cpf) && item.ativo !== false,
  );
  const session = openSessions(store).find(
    (item) => item.id === req.body.sessionId,
  );
  if (
    !student ||
    !session ||
    !(student.turmaIds || []).includes(session.turmaId)
  )
    return res.status(404).json({ error: "Aluno ou aula não encontrado." });
  return recordAttendance(store, student, session, res);
});
app.get(
  "/api/admin/overview",
  adminLimiter,
  requireAdmin,
  async (_req, res) => {
    const store = await readStore();
    res.json({
      config: store.config,
      turmas: store.turmas,
      professores: (store.professores || []).map(publicTeacher),
      alunos: store.alunos.map(publicStudent),
      checkins: store.checkins,
      attendance: attendanceReport(store),
    });
  },
);
app.post(
  "/api/admin/students",
  adminLimiter,
  requireAdmin,
  async (req, res) => {
    const name = String(req.body.nome || "")
      .trim()
      .replace(/\s+/g, " ");
    const phone = String(req.body.tel || "")
      .replace(/\D/g, "")
      .slice(0, 15);
    const cpf = onlyDigits(req.body.cpf);
    if (name.length < 3)
      return res
        .status(422)
        .json({ error: "Informe o nome completo do aluno." });
    if (!cpf || !validCpf(cpf))
      return res.status(422).json({ error: "CPF obrigatório e válido." });
    const store = await readStore();
    const storeClassIds = new Set(store.turmas.map((item) => item.id));
    const turmaIds = Array.isArray(req.body.turmaIds)
      ? req.body.turmaIds.filter(
          (id) => typeof id === "string" && storeClassIds.has(id),
        )
      : [];
    const normalizedName = name.toLocaleLowerCase();
    if (
      store.alunos.some(
        (item) =>
          item.nome.toLocaleLowerCase() === normalizedName &&
          item.ativo !== false,
      )
    )
      return res
        .status(409)
        .json({ error: "Já existe um aluno ativo com esse nome." });
    if (!turmaIds.length)
      return res.status(422).json({ error: "Selecione pelo menos uma turma." });
    if (
      store.alunos.some((item) => matchesCpf(item, cpf) && item.ativo !== false)
    )
      return res
        .status(409)
        .json({ error: "Este CPF já está vinculado a um aluno." });
    const student = {
      id: crypto.randomUUID(),
      nome: name,
      tel: phone,
      turmaIds,
      ativo: true,
      desde: String(req.body.desde || dateKey(now())),
      cpfHash: hashCpf(cpf),
      vinculo: "verificado",
      vinculoEm: Date.now(),
    };
    store.alunos.push(student);
    await writeStore(store);
    return res.status(201).json({ student: publicStudent(student) });
  },
);
app.post(
  "/api/admin/teachers",
  adminLimiter,
  requireAdmin,
  async (req, res) => {
    const name = String(req.body.nome || "")
      .trim()
      .replace(/\s+/g, " ");
    const cpf = onlyDigits(req.body.cpf);
    if (name.length < 3)
      return res
        .status(422)
        .json({ error: "Informe o nome completo do professor." });
    if (!validCpf(cpf))
      return res.status(422).json({ error: "CPF obrigatório e válido." });
    const store = await readStore();
    if (
      store.professores.some(
        (item) => matchesCpf(item, cpf) && item.ativo !== false,
      )
    )
      return res
        .status(409)
        .json({ error: "Este CPF já está vinculado a um professor." });
    const teacher = {
      id: crypto.randomUUID(),
      nome: name,
      cpfHash: hashCpf(cpf),
      ativo: true,
      vinculo: "verificado",
      vinculoEm: Date.now(),
    };
    store.professores = [...(store.professores || []), teacher];
    await writeStore(store);
    return res.status(201).json({ professor: publicTeacher(teacher) });
  },
);
app.post("/api/admin/classes", adminLimiter, requireAdmin, async (req, res) => {
  const store = await readStore();
  const code = String(req.body.id || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
  const course = String(req.body.curso || "").trim();
  const teacher = (store.professores || []).find(
    (item) => item.id === req.body.professorId && item.ativo !== false,
  );
  const weekday = Number(req.body.dia);
  if (
    !code ||
    !course ||
    !teacher ||
    !Number.isInteger(weekday) ||
    weekday < 0 ||
    weekday > 6 ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(req.body.inicio) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(req.body.fim) ||
    minutes(req.body.fim) <= minutes(req.body.inicio)
  )
    return res
      .status(422)
      .json({
        error:
          "Preencha código, curso, professor, dia e horários corretamente.",
      });
  if (store.turmas.some((item) => item.id === code))
    return res
      .status(409)
      .json({ error: "Já existe uma turma com esse código." });
  const classItem = {
    id: code,
    nome: `${code} — ${course}`,
    curso: course,
    professor: teacher.nome,
    professorId: teacher.id,
    sala: String(req.body.sala || ""),
    inicio: String(req.body.dataInicio || dateKey(now())),
    fim: String(req.body.dataFim || ""),
    ativa: true,
    canceladas: [],
    horarios: [{ dia: weekday, inicio: req.body.inicio, fim: req.body.fim }],
  };
  store.turmas.push(classItem);
  await writeStore(store);
  return res.status(201).json({ turma: classItem });
});
app.put(
  "/api/admin/teachers/:id",
  adminLimiter,
  requireAdmin,
  async (req, res) => {
    const store = await readStore();
    const teacher = (store.professores || []).find(
      (item) => item.id === req.params.id,
    );
    const name = String(req.body.nome || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!teacher)
      return res.status(404).json({ error: "Professor não encontrado." });
    if (name.length < 3)
      return res
        .status(422)
        .json({ error: "Informe o nome completo do professor." });
    if (
      store.professores.some(
        (item) =>
          item.id !== teacher.id &&
          item.nome.toLocaleLowerCase() === name.toLocaleLowerCase() &&
          item.ativo !== false,
      )
    )
      return res
        .status(409)
        .json({ error: "Já existe um professor ativo com esse nome." });
    teacher.nome = name;
    store.turmas = store.turmas.map((item) =>
      item.professorId === teacher.id ? { ...item, professor: name } : item,
    );
    await writeStore(store);
    return res.json({
      professor: publicTeacher(teacher),
      turmas: store.turmas,
    });
  },
);
app.delete(
  "/api/admin/teachers/:id",
  adminLimiter,
  requireAdmin,
  async (req, res) => {
    const store = await readStore();
    const teacher = (store.professores || []).find(
      (item) => item.id === req.params.id,
    );
    if (!teacher)
      return res.status(404).json({ error: "Professor não encontrado." });
    if (
      store.turmas.some(
        (item) => item.professorId === teacher.id && item.ativa !== false,
      )
    )
      return res
        .status(409)
        .json({
          error: "Não é possível apagar um professor ligado a uma turma ativa.",
        });
    teacher.ativo = false;
    await writeStore(store);
    return res.json({ ok: true });
  },
);
app.put(
  "/api/admin/classes/:id",
  adminLimiter,
  requireAdmin,
  async (req, res) => {
    const store = await readStore();
    const classItem = store.turmas.find((item) => item.id === req.params.id);
    const teacher = (store.professores || []).find(
      (item) => item.id === req.body.professorId && item.ativo !== false,
    );
    const course = String(req.body.curso || "").trim();
    const weekday = Number(req.body.dia);
    if (!classItem)
      return res.status(404).json({ error: "Turma não encontrada." });
    if (
      !course ||
      !teacher ||
      !Number.isInteger(weekday) ||
      weekday < 0 ||
      weekday > 6 ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(req.body.inicio) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(req.body.fim) ||
      minutes(req.body.fim) <= minutes(req.body.inicio)
    )
      return res
        .status(422)
        .json({
          error: "Preencha curso, professor, dia e horários corretamente.",
        });
    Object.assign(classItem, {
      curso: course,
      nome: `${classItem.id} — ${course}`,
      professor: teacher.nome,
      professorId: teacher.id,
      sala: String(req.body.sala || ""),
      inicio: String(req.body.dataInicio || classItem.inicio),
      fim: String(req.body.dataFim || classItem.fim || ""),
      horarios: [{ dia: weekday, inicio: req.body.inicio, fim: req.body.fim }],
    });
    await writeStore(store);
    return res.json({ turma: classItem });
  },
);
app.delete(
  "/api/admin/classes/:id",
  adminLimiter,
  requireAdmin,
  async (req, res) => {
    const store = await readStore();
    const classItem = store.turmas.find((item) => item.id === req.params.id);
    if (!classItem)
      return res.status(404).json({ error: "Turma não encontrada." });
    if (
      store.alunos.some(
        (item) =>
          item.ativo !== false && (item.turmaIds || []).includes(classItem.id),
      ) ||
      store.checkins.some((item) => item.turmaId === classItem.id)
    )
      return res
        .status(409)
        .json({
          error:
            "Não é possível apagar uma turma com alunos ou presenças vinculadas.",
        });
    store.turmas = store.turmas.filter((item) => item.id !== classItem.id);
    await writeStore(store);
    return res.json({ ok: true });
  },
);
app.put("/api/admin/config", adminLimiter, requireAdmin, async (req, res) => {
  const store = await readStore();
  store.config = {
    ...store.config,
    escola: String(req.body.escola || store.config.escola).slice(0, 120),
    minimo: Math.min(
      100,
      Math.max(0, Number(req.body.minimo || store.config.minimo)),
    ),
    tolAntes: Math.min(
      240,
      Math.max(0, Number(req.body.tolAntes ?? store.config.tolAntes)),
    ),
    tolDepois: Math.min(
      240,
      Math.max(0, Number(req.body.tolDepois ?? store.config.tolDepois)),
    ),
    inicioControle: String(
      req.body.inicioControle || store.config.inicioControle,
    ),
  };
  await writeStore(store);
  res.json({ config: store.config });
});
app.put(
  "/api/admin/students/:id",
  adminLimiter,
  requireAdmin,
  async (req, res) => {
    const store = await readStore();
    const student = store.alunos.find((item) => item.id === req.params.id);
    if (!student)
      return res.status(404).json({ error: "Aluno não encontrado." });
    Object.assign(student, {
      vinculo: req.body.vinculo || student.vinculo,
      ativo: req.body.ativo ?? student.ativo,
    });
    await writeStore(store);
    res.json({ student: publicStudent(student) });
  },
);
app.get("/api/admin/backup", adminLimiter, requireAdmin, async (_req, res) =>
  res.json(await readStore()),
);
app.post("/api/admin/import", adminLimiter, requireAdmin, async (req, res) => {
  const current = await readStore();
  if (current.alunos.length || current.turmas.length || current.checkins.length)
    return res
      .status(409)
      .json({ error: "A importação inicial exige uma base vazia." });
  const seed = req.body;
  if (
    !seed.config ||
    !Array.isArray(seed.alunos) ||
    !Array.isArray(seed.turmas) ||
    seed.alunos.length > 10000 ||
    seed.turmas.length > 1000
  )
    return res.status(422).json({ error: "Formato de importação inválido." });
  const safeText = (value) => typeof value === "string" && value.length <= 200;
  const validHash = (value) => !value || /^[a-f0-9]{64}$/.test(value);
  if (
    seed.alunos.some(
      (item) =>
        !safeText(item.id) ||
        !safeText(item.nome) ||
        !Array.isArray(item.turmaIds) ||
        !validHash(item.cpfHash),
    ) ||
    seed.turmas.some(
      (item) =>
        !safeText(item.id) ||
        !safeText(item.nome) ||
        !Array.isArray(item.horarios),
    )
  )
    return res.status(422).json({ error: "Dados de importação inválidos." });
  const imported = {
    config: {
      escola: String(seed.config.escola || "Instituto Tecnológico Tesla").slice(
        0,
        120,
      ),
      minimo: 75,
      tolAntes: 30,
      tolDepois: 60,
      inicioControle: dateKey(now()),
    },
    turmas: seed.turmas.map((item) => ({
      id: item.id,
      nome: item.nome,
      curso: String(item.curso || ""),
      professor: String(item.professor || ""),
      sala: String(item.sala || ""),
      inicio: item.inicio || "",
      fim: item.fim || "",
      horarios: item.horarios,
      ativa: item.ativa !== false,
      canceladas: [],
    })),
    alunos: seed.alunos.map((item) => ({
      id: item.id,
      nome: item.nome,
      tel: String(item.tel || ""),
      turmaIds: item.turmaIds,
      ativo: item.ativo !== false,
      desde: item.desde || "",
      cpfHash: item.cpfHash || "",
      vinculo: item.vinculo || "",
    })),
    checkins: [],
    professores: [],
  };
  imported.professores = teachersFromClasses(imported.turmas);
  imported.turmas = connectClassesToTeachers(
    imported.turmas,
    imported.professores,
  );
  await writeStore(imported);
  res
    .status(201)
    .json({
      ok: true,
      alunos: imported.alunos.length,
      turmas: imported.turmas.length,
    });
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Rota não encontrada." }),
);
app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  const status =
    error.type === "entity.parse.failed"
      ? 400
      : error.type === "entity.too.large"
        ? 413
        : 500;
  // Never log requests, CPFs, database URLs, or driver errors containing personal data.
  console.error("Falha de operação", status);
  res
    .status(status)
    .send({
      error:
        status === 500
          ? "Serviço temporariamente indisponível. Tente novamente."
          : "Requisição inválida.",
    });
});
app.get("*", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

repositoryReady
  .then(() => {
    const listener = app.listen(port, () =>
      console.log(
        `Presença Tesla em http://localhost:${listener.address().port}`,
      ),
    );
  })
  .catch((error) => {
    console.error("Não foi possível iniciar o banco de dados.");
    process.exit(1);
  });
