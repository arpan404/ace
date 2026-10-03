import { tableFeatures, useTable, type ColumnDef, type RowData } from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";

const features = tableFeatures({});
export type DataColumns<T extends RowData> = ColumnDef<typeof features, T>[];
export { features as dataTableFeatures };

/**
 * shadcn data-table pattern on TanStack Table v9. Pass module-scope `columns` and stable
 * `data`; a fresh array each render rebuilds the row model.
 */
export function DataTable<T extends RowData>(props: {
  columns: DataColumns<T>;
  data: T[];
  caption: string;
  empty?: string;
}) {
  const table = useTable({ features, columns: props.columns, data: props.data });
  const rows = table.getRowModel().rows;
  return (
    <Table>
      <caption className="sr-only">{props.caption}</caption>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder ? null : <table.FlexRender header={header} />}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.length ? (
          rows.map((row) => (
            <TableRow key={row.id}>
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : (
          <TableRow>
            <TableCell colSpan={props.columns.length} className="text-center text-muted-foreground">
              {props.empty ?? "Nothing to show."}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
