import {
  readStore,
  writeStore,
  saveWorkflow,
  withStoreLock,
} from "./repository.js";
import {
  registerTeacherAttendance,
  teacherSettings,
  validateTeacherSettings,
  sessionsOn,
} from "./teacher-attendance.js";
import {
  buildTeacherReport,
  exportTeacherWorkbook,
  reportRange,
} from "./teacher-reports.js";
import { sheetStatus, syncOnce } from "./sheet-sync.js";
import { dateKey, now } from "./domain.js";

export function registerTeacherRoutes({
  app,
  routes,
  requireAdmin,
  adminLimiter,
  kioskLimiter,
}) {
  routes.post(
    "/api/kiosk/teacher-attendance",
    kioskLimiter,
    async (req, res) => {
      const store = await readStore();
      const result = registerTeacherAttendance(store, req.body);
      if (result.changed) {
        if (!store.config.teacherAttendanceStart) {
          store.config.teacherAttendanceStart = dateKey(now());
          await writeStore(store);
        } else await saveWorkflow(store, true);
        console.info("Horário de aula registrado", {
          professorId: result.body.teacher.id,
          sessionId: result.body.record.sessionId,
          tipo: result.body.record.tipoProfessor,
          evento: result.body.record.saida ? "conclusao" : "inicio",
        });
      }
      res.status(result.status).json(result.body);
    },
  );
  routes.get(
    "/api/admin/teacher-attendance",
    adminLimiter,
    requireAdmin,
    async (req, res) => {
      const store = await readStore();
      try {
        res.json({
          ...buildTeacherReport(store, req.query),
          settings: teacherSettings(store.config),
          substitutions: store.teacherSubstitutions,
          sync: sheetStatus(store),
        });
      } catch (error) {
        res.status(422).json({ error: error.message });
      }
    },
  );
  routes.get(
    "/api/admin/teacher-sessions",
    adminLimiter,
    requireAdmin,
    async (req, res) => {
      try {
        const date = reportRange({
          from: req.query.date,
          to: req.query.date,
        }).from;
        const store = await readStore();
        res.json({
          sessions: sessionsOn(store, date).map((s) => ({
            id: s.id,
            turmaId: s.turmaId,
            turmaNome: s.turma.curso || s.turma.nome,
            inicio: s.inicio,
            fim: s.fim,
            professorId: s.turma.professorId,
            professor: s.turma.professor,
          })),
        });
      } catch {
        res.status(422).json({ error: "Data inválida." });
      }
    },
  );
  routes.put(
    "/api/admin/teacher-settings",
    adminLimiter,
    requireAdmin,
    async (req, res) => {
      try {
        const settings = validateTeacherSettings(req.body);
        const successScreenMs = Number(req.body.successScreenMs ?? 5500);
        if (
          !Number.isInteger(successScreenMs) ||
          successScreenMs < 2000 ||
          successScreenMs > 15000
        )
          throw new Error(
            "A tela de sucesso deve durar entre 2 e 15 segundos.",
          );
        const store = await readStore();
        Object.assign(store.config, {
          teacherAttendanceSettings: settings,
          successScreenMs,
          teacherAttendanceStart:
            store.config.teacherAttendanceStart || dateKey(now()),
        });
        await writeStore(store);
        res.json({ settings, config: store.config });
      } catch (error) {
        res.status(422).json({ error: error.message });
      }
    },
  );
  routes.post(
    "/api/admin/teacher-substitutions",
    adminLimiter,
    requireAdmin,
    async (req, res) => {
      const store = await readStore();
      let date;
      try {
        date = reportRange({ from: req.body.date, to: req.body.date }).from;
      } catch {
        return res.status(422).json({ error: "Data inválida." });
      }
      if (date < dateKey(now()))
        return res.status(422).json({
          error: "Agende a substituição para hoje ou uma data futura.",
        });
      const session = sessionsOn(store, date).find(
        (s) => s.id === req.body.sessionId,
      );
      const teacher = store.professores.find(
        (t) => t.id === req.body.professorId && t.ativo !== false && t.cpfHash,
      );
      if (!session || !teacher)
        return res.status(422).json({
          error: "Selecione uma aula e um professor ativo com CPF cadastrado.",
        });
      if (session.turma.professorId === teacher.id)
        return res
          .status(422)
          .json({ error: "Este professor já é o titular." });
      if (store.teacherAttendance.some((r) => r.sessionId === session.id))
        return res.status(409).json({
          error:
            "Não é possível alterar a substituição de uma aula com horário registrado.",
        });
      const substitution = {
        id: session.id,
        sessionId: session.id,
        data: date,
        turmaId: session.turmaId,
        turmaNome: session.turma.curso || session.turma.nome,
        professorPrevistoId: session.turma.professorId,
        professorPrevistoNome: session.turma.professor,
        professorId: teacher.id,
        professorNome: teacher.nome,
        inicio: session.inicio,
        fim: session.fim,
        updatedAt: now().toISOString(),
      };
      store.teacherSubstitutions = store.teacherSubstitutions
        .filter((s) => s.id !== substitution.id)
        .concat(substitution);
      await saveWorkflow(store, true);
      res.status(201).json({ substitution });
    },
  );
  routes.delete(
    "/api/admin/teacher-substitutions/:id",
    adminLimiter,
    requireAdmin,
    async (req, res) => {
      const store = await readStore();
      if (store.teacherAttendance.some((r) => r.sessionId === req.params.id))
        return res
          .status(409)
          .json({ error: "A aula já possui horário registrado." });
      store.teacherSubstitutions = store.teacherSubstitutions.filter(
        (s) => s.id !== req.params.id,
      );
      await saveWorkflow(store, true);
      res.json({ ok: true });
    },
  );
  app.get(
    "/api/admin/teacher-attendance.xlsx",
    adminLimiter,
    requireAdmin,
    async (req, res, next) => {
      try {
        let report, store;
        await withStoreLock(async () => {
          store = await readStore();
          report = buildTeacherReport(store, req.query);
        });
        const buffer = await exportTeacherWorkbook(store, report);
        res.set(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        res.set(
          "Content-Disposition",
          `attachment; filename="aulas-tesla-${report.range.from}-${report.range.to}.xlsx"`,
        );
        res.send(Buffer.from(buffer));
      } catch (error) {
        if (error.message.startsWith("Selecione"))
          res.status(422).json({ error: error.message });
        else next(error);
      }
    },
  );
  app.post(
    "/api/admin/teacher-sync",
    adminLimiter,
    requireAdmin,
    async (_req, res, next) => {
      try {
        res.json(await syncOnce());
      } catch (error) {
        next(error);
      }
    },
  );
}
