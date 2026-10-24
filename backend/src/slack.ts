
import { WebClient } from "@slack/web-api";

export async function sendSlackNotification(message: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  if (!token || !channel) {
    console.warn(
      "[Slack] Notification skipped: Slack credentials are not configured."
    );
    return;
  }

  try {
    const slack = new WebClient(token);

    await slack.chat.postMessage({
      channel,
      text: message,
    });

    console.log("[Slack] Notification sent successfully.");
  } catch (error) {
    // Slack failures should not crash or fail the email scheduler.
    console.error(
      "[Slack] Could not send notification:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}
