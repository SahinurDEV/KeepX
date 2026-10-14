import "dotenv/config";
import { createApp } from "./app.js";
import { getConfig } from "./config.js";

const app = await createApp();
const { port } = getConfig();
app.listen(port, () => {
  console.log(JSON.stringify({ level: "info", msg: "api listening", port }));
});
