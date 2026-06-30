export type ColumnSpec =
  | string
  | {
      type?: string;
      optional?: boolean;
    };

export type IndexSpec =
  | string[]
  | {
      name: string;
      fields: string[];
    };

export type TableSpec = {
  columns?: Record<string, ColumnSpec>;
  fields?: Record<string, ColumnSpec>;
  indexes?: Record<string, string[]> | IndexSpec[];
};

export type SchemaSpec =
  | {
      tables?: Record<string, TableSpec>;
    }
  | Record<string, TableSpec>;

export type NormalizedIndex = {
  name: string;
  fields: string[];
};

export type NormalizedTable = {
  name: string;
  columns: Record<string, ColumnSpec>;
  indexes: NormalizedIndex[];
};

export type NormalizedSchema = {
  tables: Record<string, NormalizedTable>;
};

export function normalizeSchema(schema: SchemaSpec): NormalizedSchema {
  const maybeTables = (schema as { tables?: Record<string, TableSpec> }).tables;
  const rawTables = maybeTables ?? (schema as Record<string, TableSpec>);
  const tables: Record<string, NormalizedTable> = {};

  for (const [name, table] of Object.entries(rawTables)) {
    if (!isTableSpec(table)) continue;
    tables[name] = {
      name,
      columns: table.columns ?? table.fields ?? {},
      indexes: normalizeIndexes(table.indexes),
    };
  }

  return { tables };
}

function normalizeIndexes(indexes: TableSpec["indexes"]): NormalizedIndex[] {
  if (!indexes) return [];
  if (Array.isArray(indexes)) {
    return indexes.map((index, position) =>
      Array.isArray(index)
        ? { name: `by_${index.join("_") || position}`, fields: index }
        : { name: index.name, fields: index.fields },
    );
  }

  return Object.entries(indexes).map(([name, fields]) => ({ name, fields }));
}

function isTableSpec(value: unknown): value is TableSpec {
  return typeof value === "object" && value !== null;
}
