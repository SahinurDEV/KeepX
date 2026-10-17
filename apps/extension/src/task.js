export function taskFromTab(title, url) {
  const name = String(title ?? "").trim().slice(0, 500) || "Saved tab";
  const link = typeof url === "string" && /^https?:\/\//.test(url) ? url.slice(0, 2000) : "";
  return { title: name, description: link };
}

export function taskFromTitle(title) {
  const name = String(title ?? "").trim().slice(0, 500);
  if (!name) return null;
  return { title: name, description: "" };
}
