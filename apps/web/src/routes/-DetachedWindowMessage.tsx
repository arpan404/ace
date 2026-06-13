export function DetachedWindowMessage(props: { title: string; description: string }) {
  return (
    <div className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-center text-foreground">
      <div>
        <h1 className="text-sm font-semibold">{props.title}</h1>
        <p className="mt-2 text-xs text-muted-foreground">{props.description}</p>
      </div>
    </div>
  );
}
