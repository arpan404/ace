import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty.tsx";

export function Placeholder(props: { title: string; description: string }) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <h1 className="text-lg font-medium">{props.title}</h1>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
