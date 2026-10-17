interface KeepXDesktop {
  notify(input: { title: string; body: string }): Promise<boolean>;
  onQuickAdd(listener: () => void): () => void;
}

interface Window {
  keepx?: KeepXDesktop;
}
