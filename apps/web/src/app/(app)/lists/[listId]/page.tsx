import { Workspace } from "@/components/workspace";

export default async function ListPage({ params }: { params: Promise<{ listId: string }> }) {
  const { listId } = await params;
  return <Workspace view={{ kind: "list", listId }} />;
}
