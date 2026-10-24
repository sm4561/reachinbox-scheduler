import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";

const redisHost = process.env.REDIS_HOST || "localhost";
const redisPort = Number(process.env.REDIS_PORT || 6379);

export const redisConnection = new IORedis({
  host: redisHost,
  port: redisPort,
  maxRetriesPerRequest: null,
});

export interface EmailAttachment {
  name: string;
  type: string;
  size: number;
  data: string;
}

export interface EmailJobData {
  emailId: string;
  ownerUid: string;
  recipient: string;
  subject: string;
  body: string;
  scheduledAt: string;
  hourlyLimit: number;
  delaySeconds: number;
  attachments: EmailAttachment[];
}

export const emailQueue = new Queue<EmailJobData>("reachinbox-emails", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: false,
    removeOnFail: false,
  },
});

export async function closeQueue(): Promise<void> {
  await emailQueue.close();
  await redisConnection.quit();
}
