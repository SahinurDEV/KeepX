import { contextBridge, ipcRenderer } from "electron";

const quickAddChannel = "quick-add";

contextBridge.exposeInMainWorld("keepx", {
  notify(input: { title: string; body: string }) {
    return ipcRenderer.invoke("notify", input);
  },
  onQuickAdd(listener: () => void) {
    const wrapped = () => listener();
    ipcRenderer.on(quickAddChannel, wrapped);
    return () => ipcRenderer.removeListener(quickAddChannel, wrapped);
  },
});
