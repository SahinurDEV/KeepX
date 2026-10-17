import { taskFromTab, taskFromTitle } from "./task.js";

const browserApi = globalThis.browser ?? globalThis.chrome;
const base = "http://127.0.0.1:3000";
const status = document.querySelector("#status");
const tokenInput = document.querySelector("#token");
const titleInput = document.querySelector("#title");
const addButton = document.querySelector("#add");
const saveTabButton = document.querySelector("#save-tab");

function say(message, kind = "") {
  status.textContent = message;
  if (kind) status.dataset.kind = kind;
  else delete status.dataset.kind;
}

function busy(on) {
  addButton.disabled = on;
  saveTabButton.disabled = on;
}

async function savedToken() {
  const stored = await browserApi.storage.local.get("token");
  return typeof stored.token === "string" ? stored.token : "";
}

async function createTask(body) {
  const token = tokenInput.value.trim();
  if (!token) {
    say("Create a token in KeepX Settings → App tokens, then paste it here.", "error");
    tokenInput.focus();
    return;
  }
  busy(true);
  say("Saving…");
  try {
    await browserApi.storage.local.set({ token });
    const response = await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      say(
        response.status === 401
          ? "That token was rejected. Create a new one in Settings."
          : "KeepX could not save the task. Is http://127.0.0.1:3000 running?",
        "error",
      );
      return;
    }
    titleInput.value = "";
    say("Saved to Inbox.", "ok");
    titleInput.focus();
  } catch {
    say("Could not reach KeepX at http://127.0.0.1:3000.", "error");
  } finally {
    busy(false);
  }
}

addButton.addEventListener("click", () => {
  const body = taskFromTitle(titleInput.value);
  if (!body) {
    say("Type a task first.", "error");
    titleInput.focus();
    return;
  }
  void createTask(body);
});

titleInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addButton.click();
});

saveTabButton.addEventListener("click", async () => {
  const tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  await createTask(taskFromTab(tab?.title, tab?.url));
});

void savedToken().then((token) => {
  tokenInput.value = token;
  (token ? titleInput : tokenInput).focus();
});
