import { Workspace } from "@/components/workspace";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const params = await searchParams;
  return <Workspace view={{ kind: "search", query: params.q ?? "" }} />;
}
