import express from "express";
import { verifyPin } from "./server/admin-auth.js";
import crypto from "node:crypto";
import path from "node:path";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import {
  rootDir as __dirname,
  salt,
  adminPinHash,
  production,
} from "./server/config.js";
import {
  readStore,
  writeStore,
  addCheckin,
  repositoryReady,
  pool,
} from "./server/repository.js";
import { transactionalRoutes } from "./server/http.js";
import {
  onlyDigits,
  now,
  dateKey,
  minutes,
  matchesCpf,
  hashCpf,
  validCpf,
  publicStudent,
  publicKioskStudent,
  publicTeacher,
  teachersFromClasses,
  connectClassesToTeachers,
  openSessions,
  attendanceReport,
} from "./server/domain.js";
const app = express();
const routes = transactionalRoutes(app);
const port = Number(process.env.PORT || 3000);
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

const sameSecret = (provided, expected) => {
  const received = Buffer.from(String(provided || ""));
  const stored = Buffer.from(String(expected || ""));
  return (
    received.length === stored.length &&
    crypto.timingSafeEqual(received, stored)
  );
};
const requireAdmin = async (req, res, next) => {
  try {
    if (await verifyPin(req.headers["x-admin-pin"], adminPinHash))
      return next();
  } catch (error) {
    return next(error);
  }
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
routes.post(
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

routes.get("/health", async (_req, res) => {
  try {
    await repositoryReady;
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
routes.get("/api/bootstrap", async (req, res) => {
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
routes.post("/api/kiosk/identify", kioskLimiter, async (req, res) => {
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
routes.get("/api/kiosk/roster", kioskLimiter, async (req, res) => {
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
routes.post("/api/kiosk/link", kioskLimiter, async (req, res) => {
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
routes.post("/api/kiosk/claim", kioskLimiter, async (req, res) => {
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
routes.post("/api/kiosk/checkin", kioskLimiter, async (req, res) => {
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
routes.get(
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
routes.post(
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
routes.post(
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
routes.post(
  "/api/admin/classes",
  adminLimiter,
  requireAdmin,
  async (req, res) => {
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
      return res.status(422).json({
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
  },
);
routes.put(
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
routes.delete(
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
      return res.status(409).json({
        error: "Não é possível apagar um professor ligado a uma turma ativa.",
      });
    teacher.ativo = false;
    await writeStore(store);
    return res.json({ ok: true });
  },
);
routes.put(
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
      return res.status(422).json({
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
routes.delete(
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
      return res.status(409).json({
        error:
          "Não é possível apagar uma turma com alunos ou presenças vinculadas.",
      });
    store.turmas = store.turmas.filter((item) => item.id !== classItem.id);
    await writeStore(store);
    return res.json({ ok: true });
  },
);
routes.put(
  "/api/admin/config",
  adminLimiter,
  requireAdmin,
  async (req, res) => {
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
  },
);
routes.put(
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
routes.get("/api/admin/backup", adminLimiter, requireAdmin, async (_req, res) =>
  res.json(await readStore()),
);
routes.post(
  "/api/admin/import",
  adminLimiter,
  requireAdmin,
  async (req, res) => {
    const current = await readStore();
    if (
      current.alunos.length ||
      current.turmas.length ||
      current.checkins.length
    )
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
    const safeText = (value) =>
      typeof value === "string" && value.length <= 200;
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
        escola: String(
          seed.config.escola || "Instituto Tecnológico Tesla",
        ).slice(0, 120),
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
    res.status(201).json({
      ok: true,
      alunos: imported.alunos.length,
      turmas: imported.turmas.length,
    });
  },
);
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
  res.status(status).send({
    error:
      status === 500
        ? "Serviço temporariamente indisponível. Tente novamente."
        : "Requisição inválida.",
  });
});
routes.get("*", (_req, res) =>
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
