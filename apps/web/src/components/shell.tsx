"use client";

import { ApiError } from "@vela/api-client";
import type { ListDto } from "@vela/shared";
import { Button, Dialog, Input } from "@vela/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  CalendarClock,
  CheckCheck,
  Inbox,
  ListTodo,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
  Tags,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Mark } from "@/components/site-frame";
import { useOnline, useToast } from "@/components/providers";
import { api, appName } from "@/lib/api";

const nav = [
  { href: "/today", label: "Today", icon: Sun },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/upcoming", label: "Upcoming", icon: CalendarClock },
  { href: "/tasks", label: "All tasks", icon: ListTodo },
  { href: "/completed", label: "Completed", icon: CheckCheck },
  { href: "/calendar", label: "Calendar", icon: Calendar },
  { href: "/tags", label: "Tags", icon: Tags },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const online = useOnline();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me(), retry: false });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api.lists(), enabled: Boolean(me.data) });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace("/login");
  }, [me.error, router]);

  useEffect(() => {
    const stored = localStorage.getItem("vela-sidebar");
    if (stored === "collapsed") setCollapsed(true);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function createList(form: FormData) {
    if (!online) {
      toast.push("You are offline. Reconnect to save changes.");
      return;
    }
    await api.createList({ name: String(form.get("name") ?? "") });
    await queryClient.invalidateQueries({ queryKey: ["lists"] });
    setListOpen(false);
  }

  function toggleTheme() {
    const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem("vela-theme", next);
  }

  async function logout() {
    await api.logout();
    queryClient.clear();
    router.replace("/login");
    router.refresh();
  }

  const activeLists = (lists.data ?? []).filter((list) => !list.archivedAt);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[auto_1fr]">
      <aside className={`${collapsed ? "md:w-16" : "md:w-64"} hidden border-r border-line bg-surface md:flex md:flex-col`}>
        <div className="flex items-center gap-2 px-3 py-4">
          <Mark className="h-8 w-8 shrink-0" />
          {collapsed ? null : <span className="font-semibold text-accent">{appName()}</span>}
          <button
            className="ml-auto rounded-md p-1 hover:bg-surface"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            type="button"
            onClick={() => {
              const next = !collapsed;
              setCollapsed(next);
              localStorage.setItem("vela-sidebar", next ? "collapsed" : "open");
            }}
          >
            <Menu className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-2">
          {nav.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} collapsed={collapsed} active={pathname === item.href} icon={item.icon} />
          ))}
          <div className="mt-4 px-2 text-xs uppercase tracking-wide text-muted">{collapsed ? "" : "Lists"}</div>
          {activeLists.map((list) => (
            <Link
              key={list.id}
              href={`/lists/${list.id}`}
              className={`truncate rounded-xl px-2 py-2 text-sm hover:bg-surface ${pathname === `/lists/${list.id}` ? "bg-accent/10 font-medium text-accent" : "text-muted"}`}
              title={list.name}
            >
              <ListDot list={list} />
              {collapsed ? null : <span className="ml-2">{list.name}</span>}
            </Link>
          ))}
          <button className="rounded-lg px-2 py-2 text-left text-sm text-muted hover:bg-surface" type="button" onClick={() => setListOpen(true)}>
            {collapsed ? "+" : "New list"}
          </button>
        </nav>
      </aside>
      <div className="flex min-h-screen min-w-0 flex-col">
        <header className="flex items-center gap-2 border-b border-line bg-bg/80 px-3 py-3 backdrop-blur md:px-5">
          <form action="/search" className="flex-1">
            <label className="sr-only" htmlFor="task-search">
              Search tasks
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                id="task-search"
                name="q"
                placeholder="Search tasks"
                className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-sm shadow-sm"
              />
            </div>
          </form>
          <button className="rounded-lg p-2 hover:bg-sidebar" type="button" aria-label="Toggle color theme" onClick={toggleTheme}>
            <Moon className="h-4 w-4 dark:hidden" />
            <Sun className="hidden h-4 w-4 dark:block" />
          </button>
          <div className="relative">
            <button className="rounded-lg px-2 py-1 text-sm hover:bg-sidebar" type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              {me.data?.name ?? "Account"}
            </button>
            {menuOpen ? (
              <div className="absolute right-0 z-20 mt-2 w-44 rounded-lg border border-line bg-surface p-1 shadow-lg">
                <Link className="block rounded-md px-2 py-2 text-sm hover:bg-sidebar" href="/settings" onClick={() => setMenuOpen(false)}>
                  Settings
                </Link>
                <button className="block w-full rounded-md px-2 py-2 text-left text-sm hover:bg-sidebar" type="button" onClick={logout}>
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </header>
        {!online ? (
          <p className="bg-sidebar px-4 py-2 text-sm">You are offline. Changes stay disabled until the connection returns.</p>
        ) : null}
        <div className="min-w-0 flex-1 pb-20 md:pb-0">{children}</div>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        {[
          { href: "/today", label: "Today", icon: Sun },
          { href: "/inbox", label: "Inbox", icon: Inbox },
          { href: "/upcoming", label: "Next", icon: CalendarClock },
          { href: "/search", label: "Search", icon: Search },
        ].map((item) => (
          <Link key={item.href} href={item.href} className="flex flex-col items-center gap-1 py-2 text-[11px]">
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        ))}
        <button className="flex flex-col items-center gap-1 py-2 text-[11px]" type="button" onClick={() => setMoreOpen(true)}>
          <Menu className="h-4 w-4" />
          More
        </button>
      </nav>
      <Dialog open={moreOpen} onOpenChange={setMoreOpen} title="More">
        <div className="grid gap-2">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="rounded-lg px-2 py-2 hover:bg-sidebar" onClick={() => setMoreOpen(false)}>
              {item.label}
            </Link>
          ))}
          <Link href="/settings" className="inline-flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-sidebar" onClick={() => setMoreOpen(false)}>
            <Settings className="h-4 w-4" /> Settings
          </Link>
        </div>
      </Dialog>
      <Dialog open={listOpen} onOpenChange={setListOpen} title="New list">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createList(new FormData(event.currentTarget));
          }}
        >
          <Input name="name" required placeholder="List name" aria-label="List name" />
          <Button type="submit">Create list</Button>
        </form>
      </Dialog>
    </div>
  );
}

function NavLink({
  href,
  label,
  collapsed,
  active,
  icon: Icon,
}: {
  href: string;
  label: string;
  collapsed: boolean;
  active: boolean;
  icon: typeof Inbox;
}) {
  return (
    <Link href={href} title={label} className={`flex items-center gap-2 rounded-xl px-2 py-2 text-sm hover:bg-surface ${active ? "bg-accent/10 font-medium text-accent" : "text-muted"}`}>
      <Icon className="h-4 w-4 shrink-0" />
      {collapsed ? null : label}
    </Link>
  );
}

function ListDot({ list }: { list: ListDto }) {
  const colors: Record<ListDto["color"], string> = {
    clay: "bg-[#b64a2a]",
    sea: "bg-[#2f6f6a]",
    plum: "bg-[#6d4c7d]",
    moss: "bg-[#4d7c0f]",
    gold: "bg-[#a16207]",
    slate: "bg-[#475569]",
    rose: "bg-[#be123c]",
    sky: "bg-[#0369a1]",
  };
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${colors[list.color]}`} />;
}
