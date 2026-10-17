import "dotenv/config";
import { createApp } from "./app.js";
import { getConfig } from "./config.js";
import { createSmtpMailer } from "./mailer.js";
import { createPushSender } from "./push.js";
import { startEmailReminderLoop } from "./services/email-reminders.js";
import { startPushReminderLoop } from "./services/push-reminders.js";

const config = getConfig();
const mailer = createSmtpMailer(config);
const push = createPushSender(config);
const app = await createApp({ mailer, push });
startEmailReminderLoop(mailer, config.appOrigin);
startPushReminderLoop(push);
app.listen(config.port, () => {
  console.log(JSON.stringify({ level: "info", msg: "api listening", port: config.port }));
});
