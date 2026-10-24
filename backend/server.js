
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const app = express();
const PORT = process.env.PORT || 5000;

// --------------------------------------------------
// 1. Middleware
// --------------------------------------------------

app.use(cors());
app.use(express.json({ limit: "15mb" }));

// --------------------------------------------------
// 2. SQLite database
// --------------------------------------------------

const dbPath =
  process.env.DB_PATH ||
  path.join(__dirname, "reachinbox.db");

const db = new Database(dbPath);

// Preserve existing records and create the table if needed.
db.exec(`
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    scheduledAt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Scheduled',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delaySeconds INTEGER NOT NULL DEFAULT 2,
    hourlyLimit INTEGER NOT NULL DEFAULT 60,
    attachments TEXT NOT NULL DEFAULT '[]',
    ownerUid TEXT
  )
`);

// Add missing columns to an existing database safely.
function ensureColumn(name, definition) {
  const columns = db.prepare("PRAGMA table_info(emails)").all();

  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE emails ADD COLUMN ${name} ${definition}`);
  }
}

ensureColumn("delaySeconds", "INTEGER NOT NULL DEFAULT 2");
ensureColumn("hourlyLimit", "INTEGER NOT NULL DEFAULT 60");
ensureColumn("attachments", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("ownerUid", "TEXT");

// --------------------------------------------------
// 3. Firebase Admin initialization
// --------------------------------------------------

const serviceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  path.join(__dirname, "serviceAccountKey.json");

if (!fs.existsSync(serviceAccountPath)) {
  throw new Error(
    "Firebase service account file is missing from the backend folder."
  );
}

const serviceAccount = require(serviceAccountPath);

const firebaseApp =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: cert(serviceAccount),
      });

const firebaseAuth = getAuth(firebaseApp);

// --------------------------------------------------
// 4. Health check
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    message: "ReachInbox backend is running!",
  });
});

// --------------------------------------------------
// 5. Firebase authentication middleware
// --------------------------------------------------

async function authenticateUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        error: "Authentication required. Please sign in.",
      });
    }

    const decodedToken = await firebaseAuth.verifyIdToken(
      match[1]
    );

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || null,
    };

    return next();
  } catch (error) {
    console.error("Authentication failed:", error.message);

    return res.status(401).json({
      error: "Your session is invalid or expired. Please sign in again.",
    });
  }
}

// --------------------------------------------------
// 6. Safely format database email records
// --------------------------------------------------

function formatEmail(email) {
  let attachments = [];

  try {
    attachments = JSON.parse(email.attachments || "[]");

    if (!Array.isArray(attachments)) {
      attachments = [];
    }
  } catch {
    attachments = [];
  }

  return {
    ...email,
    attachments,
  };
}

// --------------------------------------------------
// 7. Get only the authenticated user's emails
// --------------------------------------------------

app.get("/api/emails", authenticateUser, (req, res) => {
  try {
    const emails = db
      .prepare(`
        SELECT *
        FROM emails
        WHERE ownerUid = ?
        ORDER BY scheduledAt ASC
      `)
      .all(req.user.uid)
      .map(formatEmail);

    return res.json(emails);
  } catch (error) {
    console.error("Retrieve emails error:", error);

    return res.status(500).json({
      error: "Could not retrieve emails.",
    });
  }
});

// --------------------------------------------------
// 8. Schedule emails for the authenticated user
// --------------------------------------------------

app.post("/api/emails", authenticateUser, (req, res) => {
  try {
    const {
      recipient,
      recipients,
      subject,
      body,
      scheduledAt,
      delaySeconds = 2,
      hourlyLimit = 60,
      attachments = [],
    } = req.body;

    // Normalize and validate recipient email addresses.
    const recipientList = Array.isArray(recipients)
      ? recipients
      : [recipient];

    const leadRecipients = [
      ...new Set(
        recipientList
          .filter((value) => typeof value === "string")
          .map((value) => value.trim().toLowerCase())
          .filter((value) =>
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
          )
      ),
    ];

    const cleanSubject =
      typeof subject === "string" ? subject.trim() : "";

    const cleanBody =
      typeof body === "string" ? body.trim() : "";

    const scheduleMs =
      typeof scheduledAt === "string"
        ? Date.parse(scheduledAt)
        : NaN;

    const parsedDelay = Number(delaySeconds);
    const parsedHourlyLimit = Number(hourlyLimit);

    if (
      leadRecipients.length === 0 ||
      !cleanSubject ||
      !cleanBody ||
      !Number.isFinite(scheduleMs) ||
      scheduleMs <= Date.now() ||
      !Number.isInteger(parsedDelay) ||
      parsedDelay < 0 ||
      !Number.isInteger(parsedHourlyLimit) ||
      parsedHourlyLimit < 1 ||
      !Array.isArray(attachments)
    ) {
      return res.status(400).json({
        error:
          "Enter valid recipients, subject, body, future start time, delay, hourly limit, and attachments.",
      });
    }

    // Validate and normalize attachments.
    const safeAttachments = attachments
      .filter(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item)
      )
      .map((item) => ({
        name: String(item.name || "").slice(0, 255),
        type: String(item.type || ""),
        size: Number(item.size || 0),
        data: String(item.data || ""),
      }))
      .filter(
        (item) =>
          item.name.length > 0 &&
          (
            item.type.startsWith("image/") ||
            item.type === "application/pdf"
          ) &&
          Number.isFinite(item.size) &&
          item.size > 0 &&
          item.size <= 5 * 1024 * 1024 &&
          item.data.startsWith("data:")
      );

    const insert = db.prepare(`
      INSERT INTO emails (
        recipient,
        subject,
        body,
        scheduledAt,
        delaySeconds,
        hourlyLimit,
        attachments,
        ownerUid
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Insert the campaign transactionally.
    // Ownership is assigned by the server, never by the client.
    const insertMany = db.transaction((emailRecipients) => {
      return emailRecipients.map((emailRecipient, index) => {
        const result = insert.run(
          emailRecipient,
          cleanSubject,
          cleanBody,
          new Date(
            scheduleMs + index * parsedDelay * 1000
          ).toISOString(),
          parsedDelay,
          parsedHourlyLimit,
          JSON.stringify(safeAttachments),
          req.user.uid
        );

        return db
          .prepare("SELECT * FROM emails WHERE id = ?")
          .get(result.lastInsertRowid);
      });
    });

    const savedEmails = insertMany(leadRecipients);

    return res.status(201).json(savedEmails.map(formatEmail));
  } catch (error) {
    console.error("Schedule campaign error:", error);

    return res.status(500).json({
      error: "Could not schedule the campaign.",
    });
  }
});

// --------------------------------------------------
// 9. Start the server
// --------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(
    `ReachInbox backend running at http://localhost:${PORT}`
  );
});

// Close resources cleanly when the process stops.
function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
