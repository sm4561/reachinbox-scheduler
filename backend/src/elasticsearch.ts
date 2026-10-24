
import { Client } from "@elastic/elasticsearch";

export const elasticsearch = new Client({
  node: process.env.ELASTICSEARCH_URL || "http://localhost:9200",
});

export const EMAIL_INDEX = "reachinbox-emails";

export async function initializeElasticsearch(): Promise<void> {
  const exists = await elasticsearch.indices.exists({
    index: EMAIL_INDEX,
  });

  if (!exists) {
    await elasticsearch.indices.create({
      index: EMAIL_INDEX,
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

  console.log("Elasticsearch email index initialized.");
}
