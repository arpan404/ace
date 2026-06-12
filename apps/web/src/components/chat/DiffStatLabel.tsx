export function DiffStatLabel(props: {
  additions: number;
  deletions: number;
  showParentheses?: boolean;
}) {
  const { additions, deletions, showParentheses = false } = props;
  return (
    <>
      {showParentheses && <span className="text-muted-foreground/70">(</span>}
      <span className="text-success">+{additions}</span>
      <span aria-hidden="true" className="mx-1 text-muted-foreground/90">
        /
      </span>
      <span className="text-destructive">-{deletions}</span>
      {showParentheses && <span className="text-muted-foreground/70">)</span>}
    </>
  );
}
