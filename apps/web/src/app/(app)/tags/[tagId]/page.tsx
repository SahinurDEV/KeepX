import { Workspace } from "@/components/workspace";

export default async function TagTasksPage({ params }: { params: Promise<{ tagId: string }> }) {
  const { tagId } = await params;
  return <Workspace view={{ kind: "tag", tagId }} />;
}
