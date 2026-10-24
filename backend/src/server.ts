import {
  elasticsearch,
  initializeSearchIndex,
  indexEmail,
} from "./search";
import { startWorker, closeWorker } from "./worker";
import { emailQueue, EmailJobData, closeQueue } from "./queue";
import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { initializeDatabase, pool } from "./db";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";


const app = express();
const PORT = Number(process.env.PORT || 5000);

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
}));
app.use(express.json({ limit: "2mb" }));

// Bull Board: live view of the BullMQ email queue.
// Open http://localhost:5000/admin/queues while the backend is running.
const bullBoardAdapter = new ExpressAdapter();
bullBoardAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter: bullBoardAdapter,
});

app.use("/admin/queues", bullBoardAdapter.getRouter());

// Initialize Firebase Admin without exposing credentials in source code.

if (getApps().length === 0) {
  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    path.join(__dirname, "..", "serviceAccountKey.json");

  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(
      `Firebase service account file not found: ${serviceAccountPath}`
    );
  }

  const serviceAccount = JSON.parse(
    fs.readFileSync(serviceAccountPath, "utf8")
  );

  initializeApp({
    credential: cert(serviceAccount),
  });
}


interface AuthenticatedRequest extends Request {
  ownerUid?: string;
}

async function authenticateUser(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing Firebase authentication token." });
      return;
    }

    const token = authorization.slice("Bearer ".length);
    const decodedToken = await getAuth().verifyIdToken(token);
    req.ownerUid = decodedToken.uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired authentication token." });
  }
}

app.get("/", (_req: Request, res: Response) => {
  res.json({ message: "ReachInbox TypeScript API is running." });
});

app.get(
  "/api/emails",
  authenticateUser,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const status = String(req.query.status || "").toLowerCase();
      const allowedStatuses = ["scheduled", "processing", "sent", "failed"];

      const values: unknown[] = [req.ownerUid];
      let query = `
        SELECT id, recipient, subject, body, scheduled_at,
               status, sent_at, error_message, created_at
        FROM emails
        WHERE owner_uid = $1
      `;

      if (status && allowedStatuses.includes(status)) {
        values.push(status);
        query += " AND status = $2";
      }

      query += " ORDER BY scheduled_at DESC LIMIT 500";

      const result = await pool.query(query, values);
      res.json(result.rows);
    } catch (error) {
      console.error("Failed to fetch emails:", error);
      res.status(500).json({ error: "Failed to fetch emails." });
    }
  }
);


app.get(
  "/api/emails/search",
  authenticateUser,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const q = String(req.query.q || "").trim();

      if (!q) {
        res.status(400).json({ error: "Provide a search query." });
        return;
      }

      const result = await elasticsearch.search({
        index: process.env.ELASTICSEARCH_INDEX || "reachinbox-emails",
        query: {
          bool: {
            filter: [
              { term: { ownerUid: req.ownerUid! } },
            ],
            must: [
              {
                multi_match: {
                  query: q,
                  fields: ["recipient", "subject", "body"],
                  type: "best_fields",
                },
              },
            ],
          },
        },
        size: 100,
      });

      res.json(
        result.hits.hits.map((hit) => hit._source),
      );
    } catch (error) {
      console.error("Email search failed:", error);
      res.status(500).json({ error: "Email search failed." });
    }
  },
);


app.post(
  "/api/emails",
  authenticateUser,
  async (req: AuthenticatedRequest, res: Response) => {
    const {
      recipients,
      recipient,
      subject,
      body = "",
      scheduledAt,
      delaySeconds = 0,
      hourlyLimit = 100,
      attachments = [],
    } = req.body ?? {};

    // Accept the array used by App.tsx and the older single-recipient format.
    const recipientList: string[] = Array.isArray(recipients)
      ? recipients
      : typeof recipient === "string"
        ? [recipient]
        : [];

    const cleanRecipients = [
      ...new Set(
        recipientList
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
      ),
    ];

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const scheduledTime = new Date(scheduledAt);
    const delay = Number(delaySeconds);
    const limit = Number(hourlyLimit);

    if (
      cleanRecipients.length === 0 ||
      cleanRecipients.some((address) => !emailPattern.test(address)) ||
      typeof subject !== "string" ||
      !subject.trim() ||
      typeof body !== "string" ||
      !scheduledAt ||
      Number.isNaN(scheduledTime.getTime()) ||
      !Number.isFinite(delay) ||
      delay < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10000 ||
      !Array.isArray(attachments)
    ) {
      res.status(400).json({
        error:
          "Provide valid recipients, subject, body, future schedule, delay, hourly limit, and attachments.",
      });
      return;
    }

    if (scheduledTime.getTime() <= Date.now()) {
      res.status(400).json({
        error: "Choose a start date and time in the future.",
      });
      return;
    }

    // Validate attachment objects before saving them.
    const validAttachments = attachments.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "name" in item &&
        "type" in item &&
        "size" in item &&
        "data" in item &&
        typeof item.name === "string" &&
        typeof item.type === "string" &&
        typeof item.size === "number" &&
        typeof item.data === "string"
    );

    if (!validAttachments) {
      res.status(400).json({
        error: "One or more attachments have an invalid format.",
      });
      return;
    }

    const idempotencyKey =
      req.header("Idempotency-Key")?.trim() || null;

    let client;

    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const createdEmails: Array<Record<string, unknown>> = [];

      for (const address of cleanRecipients) {
        // Derive a distinct key for each recipient in a batch.
        const recipientKey = idempotencyKey
          ? `${idempotencyKey}:${address}`
          : null;

        const inserted = await client.query(
          `INSERT INTO emails (
             owner_uid,
             recipient,
             subject,
             body,
             scheduled_at,
             idempotency_key,
             hourly_limit,
             attachments
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, recipient, subject, body, scheduled_at, status,
                     hourly_limit, attachments`,
          [
            req.ownerUid,
            address,
            subject.trim(),
            body,
            scheduledTime.toISOString(),
            recipientKey,
            limit,
            JSON.stringify(attachments),
          ]
        );

        const email = inserted.rows[0];
        const jobId = `email-${email.id}`;

        await client.query(
          `UPDATE emails
           SET job_id = $1, updated_at = NOW()
           WHERE id = $2`,
          [jobId, email.id]
        );

        createdEmails.push({
          ...email,
          scheduledAt: new Date(email.scheduled_at).toISOString(),
          job_id: jobId,
        });
      }

      await client.query("COMMIT");

      // Add one delayed job per recipient.
      const queueFailures: string[] = [];

      for (const email of createdEmails) {
        const jobId = String(email.job_id);
        const emailId = String(email.id);

        const jobData: EmailJobData = {
          emailId,
          ownerUid: req.ownerUid!,
          recipient: String(email.recipient),
          subject: String(email.subject),
          body: String(email.body ?? ""),
          scheduledAt: String(email.scheduledAt),
          hourlyLimit: Number(email.hourly_limit),
          delaySeconds: delay,
          attachments: attachments,
        };

        try {
          await emailQueue.add("send-email", jobData, {
            jobId,
            delay: Math.max(
              0,
              scheduledTime.getTime() - Date.now()
            ),
          });
        } catch (queueError) {
          console.error(`Failed to enqueue ${jobId}:`, queueError);
          queueFailures.push(emailId);

          await pool.query(
            `UPDATE emails
             SET status = 'failed',
                 error_message = 'Unable to enqueue email job',
                 updated_at = NOW()
             WHERE id = $1 AND status = 'scheduled'`,
            [emailId]
          );
        }
      }

      if (queueFailures.length > 0) {
        res.status(503).json({
          message: "Some email jobs could not be queued.",
          emails: createdEmails,
          failedToQueue: queueFailures,
        });
        return;
      }

for (const email of createdEmails) {
  try {
    await indexEmail({
      id: String(email.id),
      ownerUid: req.ownerUid!,
      recipient: String(email.recipient),
      subject: String(email.subject),
      body: String(email.body ?? ""),
      status: "scheduled",
      scheduledAt: String(email.scheduledAt),
      sentAt: null,
    });
  } catch (error) {
    // Search indexing must not prevent a scheduled email from being queued.
    console.error(`Failed to index email ${String(email.id)}:`, error);
  }
}

      res.status(201).json({
        message: `${createdEmails.length} email(s) scheduled successfully.`,
        emails: createdEmails,
        // Preserve compatibility with code expecting a single email.
        email: createdEmails[0],
      });
    } catch (error: unknown) {
      if (client) {
        await client.query("ROLLBACK").catch(() => undefined);
      }

      const pgError = error as { code?: string };

      if (pgError.code === "23505") {
        res.status(409).json({
          error:
            "This Idempotency-Key has already been used for one or more recipients.",
        });
        return;
      }

      console.error("Failed to schedule emails:", error);
      res.status(500).json({
        error: "Failed to schedule emails.",
      });
    } finally {
      client?.release();
    }
  }
);


async function startServer(): Promise<void> {
  await initializeDatabase();

  await initializeSearchIndex();

  // Index existing database records so older emails are searchable too.
  const existingEmails = await pool.query(`
    SELECT id, owner_uid, recipient, subject, body,
           status, scheduled_at, sent_at
    FROM emails
  `);

  for (const email of existingEmails.rows) {
    try {
      await indexEmail({
        id: String(email.id),
        ownerUid: email.owner_uid,
        recipient: email.recipient,
        subject: email.subject,
        body: email.body ?? "",
        status: email.status,
        scheduledAt: new Date(email.scheduled_at).toISOString(),
        sentAt: email.sent_at
          ? new Date(email.sent_at).toISOString()
          : null,
      });
    } catch (error) {
      console.error(`Failed to index existing email ${email.id}:`, error);
    }
  }


  const server = app.listen(PORT, () => {
    console.log(
      `ReachInbox TypeScript API running at http://localhost:${PORT}`
    );
  });

  startWorker();

  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log("Shutting down ReachInbox...");

    server.close(async (error) => {
      try {
        if (error) {
          console.error("HTTP server shutdown error:", error);
        }

        await closeWorker();
        await closeQueue();
        await pool.end();

        console.log("Connections closed.");
        process.exit(error ? 1 : 0);
      } catch (shutdownError) {
        console.error("Shutdown error:", shutdownError);
        process.exit(1);
      }
    });
  }

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

startServer().catch((error: unknown) => {
  console.error("Could not start API:", error);
  process.exit(1);
});

