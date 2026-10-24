
import { Client } from "@elastic/elasticsearch";

const node = process.env.ELASTICSEARCH_URL || "http://localhost:9200";
const index = process.env.ELASTICSEARCH_INDEX || "reachinbox-emails";

export const elasticsearch = new Client({ node });

export interface SearchableEmail {
  id: string | number;
  ownerUid: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: string;
  sentAt?: string | null;
}

export async function initializeSearchIndex(): Promise<void> {
  const exists = await elasticsearch.indices.exists({ index });

  if (!exists) {
    await elasticsearch.indices.create({
      index,
      mappings: {
        properties: {
          emailId: { type: "keyword" },
          ownerUid: { type: "keyword" },
          recipient: { type: "text" },
          subject: { type: "text" },
          body: { type: "text" },
          status: { type: "keyword" },
          scheduledAt: { type: "date" },
          sentAt: { type: "date" },
        },
      },
    });
  }

  console.log(`Elasticsearch index "${index}" is ready.`);
}

export async function indexEmail(email: SearchableEmail): Promise<void> {
  await elasticsearch.index({
    index,
    id: `${email.ownerUid}-${email.id}`,
    document: {
      emailId: String(email.id),
      ownerUid: email.ownerUid,
      recipient: email.recipient,
      subject: email.subject,
      body: email.body,
      status: email.status,
      scheduledAt: email.scheduledAt,
      sentAt: email.sentAt ?? null,
    },
    refresh: "wait_for",
  });
}

export async function searchEmails(
  ownerUid: string,
  query: string,
) {
  const result = await elasticsearch.search({
    index,
    size: 100,
    query: {
      bool: {
        filter: [
          { term: { ownerUid } },
        ],
        must: [
          {
            multi_match: {
              query,
              fields: [
                "recipient",
                "subject",
                "body",
                "status",
              ],
              type: "best_fields",
              fuzziness: "AUTO",
            },
          },
        ],
      },
    },
    sort: [
      { scheduledAt: { order: "desc", unmapped_type: "date" } },
    ],
  });

  return result.hits.hits.map((hit) => hit._source);
}
