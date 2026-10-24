import { sendSlackNotification } from "./slack";
import "dotenv/config";
import { Worker, Job, DelayedError } from "bullmq";
import IORedis from "ioredis";
import nodemailer, { type SendMailOptions } from "nodemailer";
import { Client } from "@elastic/elasticsearch";
import { pool } from "./db";
import { EmailAttachment, EmailJobData } from "./queue";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
});

const elasticsearch = new Client({
  node: process.env.ELASTICSEARCH_URL || "http://localhost:9200",
});

const EMAIL_INDEX = "reachinbox-emails";

const concurrency = Math.max(
  1,
  Number(process.env.WORKER_CONCURRENCY || 5)
);

const defaultHourlyLimit = Math.max(
  1,
  Number(process.env.EMAILS_PER_HOUR || 100)
);

const configuredMinimumDelayMs = Math.max(
  0,
  Number(process.env.MIN_SEND_DELAY_MS || 1000)
);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.ethereal.email",
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.ETHEREAL_USER,
    pass: process.env.ETHEREAL_PASS,
  },
});

interface SlotReservation {
  waitMs: number;
  reason: "none" | "rate_limit" | "spacing";
}

// Refresh the Elasticsearch document using the authoritative PostgreSQL row.
// Elasticsearch errors must not turn a successfully sent email into a failed one.
async function syncEmailToElasticsearch(
  emailId: string,
  ownerUid: string
): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT id, owner_uid, recipient, subject, body,
              scheduled_at, status, sent_at, error_message, created_at
       FROM emails
       WHERE id = $1 AND owner_uid = $2`,
      [emailId, ownerUid]
    );

    if (result.rowCount === 0) {
      console.warn(
        `Cannot index email ${emailId}: PostgreSQL record was not found.`
      );
      return;
    }

    const email = result.rows[0];

    await elasticsearch.index({
      index: EMAIL_INDEX,
      id: String(email.id),
      document: {
        id: String(email.id),
        owner_uid: email.owner_uid,
        recipient: email.recipient,
        subject: email.subject,
        body: email.body,
        scheduled_at: email.scheduled_at,
        status: email.status,
        sent_at: email.sent_at,
        error_message: email.error_message,
        created_at: email.created_at,
      },
      refresh: true,
    });

    console.log(
      `Elasticsearch synchronized email ${emailId}: ${email.status}.`
    );
  } catch (error) {
    console.error(
      `Elasticsearch sync failed for email ${emailId}:`,
      error
    );
  }
}

// Atomically enforce hourly limits and spacing across workers using Redis.

async function reserveSendSlot(
  ownerUid: string,
  hourlyLimit: number,
  minimumDelayMs: number
): Promise<SlotReservation> {
  const now = Date.now();
  const hourWindow = Math.floor(now / 3_600_000);

  const rateKey = `reachinbox:rate:${ownerUid}:${hourWindow}`;
  const spacingKey = `reachinbox:spacing:${ownerUid}`;

  const script = `
    local now = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local spacing = tonumber(ARGV[3])
    local hourEnd = tonumber(ARGV[4])

    local count = tonumber(redis.call('GET', KEYS[1]) or '0')

    if count >= limit then
      return {math.max(1, hourEnd - now + 100), 'rate_limit'}
    end

    local nextAllowed = tonumber(redis.call('GET', KEYS[2]) or '0')

    if nextAllowed > now then
      return {nextAllowed - now, 'spacing'}
    end

    redis.call('INCR', KEYS[1])
    redis.call('EXPIRE', KEYS[1], 3700)

    redis.call(
      'SET',
      KEYS[2],
      now + spacing,
      'PX',
      math.max(spacing + 60000, 60000)
    )

    return {0, 'none'}
  `;

  const result = (await connection.eval(
    script,
    2,
    rateKey,
    spacingKey,
    String(now),
    String(hourlyLimit),
    String(minimumDelayMs),
    String((hourWindow + 1) * 3_600_000)
  )) as [number | string, string];

  return {
    waitMs: Number(result[0]),
    reason: result[1] as SlotReservation["reason"],
  };
}


function toNodemailerAttachments(
  attachments: EmailAttachment[]
): SendMailOptions["attachments"] {
  return attachments.map((attachment) => {
    const match = attachment.data.match(
      /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/
    );

    if (!match) {
      throw new Error(
        `Invalid attachment data for ${attachment.name}`
      );
    }

    const content = Buffer.from(match[2], "base64");

    if (content.length > 5 * 1024 * 1024) {
      throw new Error(
        `Attachment ${attachment.name} exceeds the 5 MB limit.`
      );
    }

    return {
      filename: attachment.name,
      contentType: attachment.type || match[1],
      content,
    };
  });
}

async function processEmail(
  job: Job<EmailJobData>
): Promise<void> {
  const {
    emailId,
    ownerUid,
    recipient,
    subject,
    body,
    hourlyLimit,
    delaySeconds,
    attachments = [],
  } = job.data;

  const result = await pool.query(
    `SELECT status
     FROM emails
     WHERE id = $1 AND owner_uid = $2`,
    [emailId, ownerUid]
  );

  if (result.rowCount === 0) {
    console.warn(`Email ${emailId} not found for its owner.`);
    return;
  }

  if (result.rows[0].status === "sent") {
    console.log(`Email ${emailId} was already sent; skipping.`);
    return;
  }

  // Claim the email atomically to prevent concurrent processing.
  const claim = await pool.query(
    `UPDATE emails
     SET status = 'processing',
         updated_at = NOW()
     WHERE id = $1
       AND owner_uid = $2
       AND (
         status IN ('scheduled', 'failed')
         OR (
           status = 'processing'
           AND updated_at < NOW() - INTERVAL '10 minutes'
         )
       )
     RETURNING id`,
    [emailId, ownerUid]
  );

  if (claim.rowCount === 0) {
    console.log(
      `Email ${emailId} is already processing or is not eligible.`
    );
    return;
  }

  try {
    const limit = Math.max(
      1,
      Number(hourlyLimit) || defaultHourlyLimit
    );

    const requestedDelayMs = Math.max(
      0,
      Number(delaySeconds || 0) * 1000
    );

    const minimumDelayMs = Math.max(
      configuredMinimumDelayMs,
      requestedDelayMs
    );

    const reservation = await reserveSendSlot(
      ownerUid,
      limit,
      minimumDelayMs
    );

    if (reservation.waitMs > 0) {
      
      if (reservation.reason === "rate_limit") {
        // Send at most one alert per owner per UTC hour.
        const hourWindow = Math.floor(Date.now() / 3_600_000);
        const alertKey =
          `reachinbox:slack-alert:${ownerUid}:${hourWindow}`;

        try {
          const claimed = await connection.set(
            alertKey,
            "1",
            "EX",
            3700,
            "NX"
          );

          if (claimed === "OK") {
            await sendSlackNotification(
              `⚠️ ReachInbox hourly email limit reached.\n` +
              `Owner: ${ownerUid}\n` +
              `Limit: ${Math.max(1, Number(hourlyLimit) || defaultHourlyLimit)} emails/hour\n` +
              `Pending email: ${emailId}\n` +
              `Scheduled sending will resume after the current UTC hour window.`
            );
          }
        } catch (slackError) {
          // Slack/alert failures must not stop email scheduling.
          console.error(
            "[Slack] Rate-limit alert failed:",
            slackError instanceof Error
              ? slackError.message
              : "Unknown error"
          );
        }
      }

      await pool.query(
        `UPDATE emails
         SET status = 'scheduled',
             updated_at = NOW()
         WHERE id = $1
           AND owner_uid = $2
           AND status = 'processing'`,
        [emailId, ownerUid]
      );

      await syncEmailToElasticsearch(emailId, ownerUid);

      await job.moveToDelayed(
        Date.now() + reservation.waitMs,
        job.token!
      );

      console.log(
        `Email ${emailId} delayed by ${reservation.waitMs} ms.`
      );

      throw new DelayedError();
    }

    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.ETHEREAL_USER,
      to: recipient,
      subject,
      text: body,
      attachments: toNodemailerAttachments(attachments),
    });

    console.log(
      `Email ${emailId} accepted by SMTP. Message ID: ${info.messageId}`
    );

    const update = await pool.query(
      `UPDATE emails
       SET status = 'sent',
           sent_at = NOW(),
           updated_at = NOW(),
           error_message = NULL
       WHERE id = $1
         AND owner_uid = $2
         AND status = 'processing'
       RETURNING id`,
      [emailId, ownerUid]
    );

    if (update.rowCount === 0) {
      throw new Error(
        `SMTP accepted email ${emailId}, but its database status could not be updated.`
      );
    }

    await syncEmailToElasticsearch(emailId, ownerUid);

    console.log(`Email ${emailId} status updated to sent.`);
  } catch (error) {
    if (error instanceof DelayedError) {
      throw error;
    }

    const message =
      error instanceof Error
        ? error.message
        : "Unknown email sending error";

    console.error(`Email ${emailId} processing error: ${message}`);

    await pool.query(
      `UPDATE emails
       SET status = 'failed',
           error_message = $3,
           updated_at = NOW()
       WHERE id = $1
         AND owner_uid = $2
         AND status = 'processing'`,
      [emailId, ownerUid, message]
    );

    await syncEmailToElasticsearch(emailId, ownerUid);

    throw error;
  }
}

let emailWorker: Worker<EmailJobData> | undefined;

export function startWorker(): void {
  if (emailWorker) return;

  emailWorker = new Worker<EmailJobData>(
    "reachinbox-emails",
    processEmail,
    {
      connection,
      concurrency,
    }
  );

  emailWorker.on("completed", (job) => {
    console.log(`Email job ${job.id} completed.`);
  });

  emailWorker.on("failed", (job, error) => {
    console.error(
      `Email job ${job?.id} failed: ${error.message}`
    );
  });

  emailWorker.on("error", (error) => {
    console.error("BullMQ worker error:", error);
  });

  console.log(
    `Email worker started with concurrency ${concurrency}.`
  );
}

export async function closeWorker(): Promise<void> {
  if (emailWorker) {
    await emailWorker.close();
    emailWorker = undefined;
  }

  if (connection.status !== "end") {
    await connection.quit();
  }
}
