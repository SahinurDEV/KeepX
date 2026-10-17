import { createApiClient } from "@vela/api-client";
import type { TaskDto } from "@vela/shared";
import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { normalizeBaseUrl, signIn } from "./src/session";

type ViewKind = "inbox" | "today" | "all";

function dueLabel(task: TaskDto): string | null {
  if (!task.dueAt) return null;
  const date = new Date(task.dueAt);
  if (Number.isNaN(date.getTime())) return null;
  return task.dueHasTime
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function App() {
  const [baseUrl, setBaseUrl] = useState("http://10.0.2.2:4000");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<ViewKind>("inbox");
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const api = useMemo(() => createApiClient(normalizeBaseUrl(baseUrl) ?? "", { token: () => token }), [baseUrl, token]);

  const load = useCallback(async () => {
    const result = await api.listTasks({ view });
    setTasks(result.tasks.filter((task) => task.status !== "completed" && task.status !== "archived" && !task.deletedAt));
  }, [api, view]);

  async function enter() {
    const origin = normalizeBaseUrl(baseUrl);
    if (!origin) {
      setMessage("Enter an http address for the KeepX API.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const next = await signIn(origin, email.trim(), password);
      setToken(next);
      const result = await createApiClient(origin, { token: () => next }).listTasks({ view: "inbox" });
      setTasks(result.tasks.filter((task) => task.status !== "completed" && task.status !== "archived" && !task.deletedAt));
      setView("inbox");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function switchView(next: ViewKind) {
    if (next === view) return;
    setView(next);
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.listTasks({ view: next });
      setTasks(result.tasks.filter((task) => task.status !== "completed" && task.status !== "archived" && !task.deletedAt));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load tasks.");
    } finally {
      setBusy(false);
    }
  }

  async function addTask() {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.createTask({ title: nextTitle }, `phone-${Date.now()}`);
      setTitle("");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add the task.");
    } finally {
      setBusy(false);
    }
  }

  async function finish(task: TaskDto) {
    setBusy(true);
    try {
      await api.completeTask(task.id);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not complete the task.");
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    setToken(null);
    setTasks([]);
    setTitle("");
    setMessage(null);
    setView("inbox");
  }

  if (!token) {
    return (
      <View style={styles.screen}>
        <Text style={styles.brand}>KeepX</Text>
        <Text style={styles.title}>Sign in on this phone</Text>
        <Text style={styles.help}>
          Native Android client. It talks to your KeepX API over http — not a website wrapped in a browser. Emulator: 10.0.2.2. Phone on Wi‑Fi: this computer’s LAN address and port 4000.
        </Text>
        <Text style={styles.label}>API address</Text>
        <TextInput style={styles.input} value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" autoCorrect={false} />
        <Text style={styles.label}>Email</Text>
        <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="Email" autoCapitalize="none" autoCorrect={false} />
        <Text style={styles.label}>Password</Text>
        <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
        {message ? <Text style={styles.error}>{message}</Text> : null}
        <Pressable style={styles.button} disabled={busy} onPress={() => void enter()}>
          <Text style={styles.buttonText}>{busy ? "Please wait…" : "Sign in"}</Text>
        </Pressable>
      </View>
    );
  }

  const heading = view === "today" ? "Today" : view === "all" ? "All tasks" : "Inbox";

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <View>
          <Text style={styles.brand}>KeepX</Text>
          <Text style={styles.title}>{heading}</Text>
        </View>
        <Pressable onPress={signOut} accessibilityRole="button" accessibilityLabel="Sign out of KeepX">
          <Text style={styles.link}>Sign out</Text>
        </Pressable>
      </View>
      <View style={styles.tabs}>
        {(
          [
            ["inbox", "Inbox"],
            ["today", "Today"],
            ["all", "All"],
          ] as const
        ).map(([id, label]) => (
          <Pressable
            key={id}
            style={[styles.tab, view === id ? styles.tabOn : null]}
            accessibilityRole="button"
            accessibilityState={{ selected: view === id }}
            onPress={() => void switchView(id)}
          >
            <Text style={[styles.tabText, view === id ? styles.tabTextOn : null]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {view === "inbox" ? (
        <View style={styles.row}>
          <TextInput style={[styles.input, styles.grow]} value={title} onChangeText={setTitle} placeholder="Add a task" />
          <Pressable style={styles.button} disabled={busy} onPress={() => void addTask()}>
            <Text style={styles.buttonText}>Add</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.help}>Tap a task to mark it finished. Add new tasks from Inbox.</Text>
      )}
      {message ? <Text style={styles.error}>{message}</Text> : null}
      <FlatList
        data={tasks}
        keyExtractor={(task) => task.id}
        ListEmptyComponent={<Text style={styles.help}>{busy ? "Loading…" : "Nothing here yet."}</Text>}
        renderItem={({ item }) => {
          const due = dueLabel(item);
          return (
            <Pressable style={styles.task} disabled={busy} onPress={() => void finish(item)}>
              <Text style={styles.taskTitle}>{item.title}</Text>
              {due ? <Text style={styles.meta}>Due {due}</Text> : null}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f4f7fb", padding: 20, paddingTop: 56, gap: 12 },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  brand: { color: "#3869f0", fontSize: 18, fontWeight: "700", letterSpacing: -0.3 },
  title: { color: "#172033", fontSize: 32, fontWeight: "600", letterSpacing: -0.6, marginTop: 2 },
  help: { color: "#52627a", lineHeight: 20 },
  label: { color: "#172033", fontSize: 12, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#d5deea", borderRadius: 12, backgroundColor: "white", paddingHorizontal: 12, paddingVertical: 10 },
  button: { borderRadius: 999, backgroundColor: "#3869f0", paddingHorizontal: 16, paddingVertical: 12, alignItems: "center" },
  buttonText: { color: "white", fontWeight: "600" },
  error: { color: "#b42318" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  grow: { flex: 1 },
  task: { borderWidth: 1, borderColor: "#d5deea", borderRadius: 14, backgroundColor: "white", padding: 14, marginBottom: 8, gap: 4 },
  taskTitle: { color: "#172033", fontSize: 16, fontWeight: "500" },
  meta: { color: "#52627a", fontSize: 13 },
  tabs: { flexDirection: "row", gap: 8 },
  tab: { borderRadius: 999, borderWidth: 1, borderColor: "#d5deea", backgroundColor: "white", paddingHorizontal: 14, paddingVertical: 8 },
  tabOn: { backgroundColor: "#3869f0", borderColor: "#3869f0" },
  tabText: { color: "#172033", fontWeight: "600", fontSize: 13 },
  tabTextOn: { color: "white" },
  link: { color: "#3869f0", fontWeight: "600", marginTop: 6 },
});
