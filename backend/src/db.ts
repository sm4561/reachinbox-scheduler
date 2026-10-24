
import "dotenv/config";
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function initializeDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS emails (
      id BIGSERIAL PRIMARY KEY,
      owner_uid TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      scheduled_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'processing', 'sent', 'failed')),
      sent_at TIMESTAMPTZ,
      error_message TEXT,
      job_id TEXT UNIQUE,
      idempotency_key TEXT,
      hourly_limit INTEGER NOT NULL DEFAULT 100,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Safely add columns to databases created by the earlier schema.
  await pool.query(`
    ALTER TABLE emails
      ADD COLUMN IF NOT EXISTS hourly_limit INTEGER NOT NULL DEFAULT 100,
      ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_emails_owner_status
    ON emails (owner_uid, status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_emails_scheduled_at
    ON emails (scheduled_at)
    WHERE status = 'scheduled';
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_owner_idempotency
    ON emails (owner_uid, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  `);

  console.log("PostgreSQL email schema initialized.");
}
