import { ingestLogEvidenceFromFile, searchLogEvidence } from "../src/log-rag";

type CliOptions = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string | null; options: CliOptions } {
  const [command, ...rest] = argv;
  const options: CliOptions = {};

  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (!current || !current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return {
    command: command ?? null,
    options,
  };
}

function usage(): string {
  return `
Usage:
  bun script/log-rag.ts ingest --input logs/oc.decoded.ndjson [--source-file logs/oc.decoded.ndjson] [--all-events]
  bun script/log-rag.ts search --query "chat completions" [--limit 5] [--request-type both] [--source sse_processor]

Options:
  --input           NDJSON input file path
  --source-file     Source label stored in the evidence index
  --all-events      Disable AI-only filtering during ingest
  --query           Search query
  --limit           Max returned hits, default 5
  --request-type    request | response | unknown | both
  --source          Exact source filter
  --host            Host fuzzy filter
  --path-keyword    Path fuzzy filter
  --include-raw     Include raw JSON in search results
`.trim();
}

function getStringOption(options: CliOptions, key: string): string | null {
  const value = options[key];
  return typeof value === "string" ? value : null;
}

function getBooleanOption(options: CliOptions, key: string): boolean {
  return options[key] === true;
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(Bun.argv.slice(2));

  if (command === "ingest") {
    const inputPath = getStringOption(options, "input");
    if (!inputPath) {
      throw new Error("--input is required for ingest");
    }

    const result = await ingestLogEvidenceFromFile(inputPath, {
      sourceFile: getStringOption(options, "source-file") ?? undefined,
      aiOnly: !getBooleanOption(options, "all-events"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "search") {
    const query = getStringOption(options, "query");
    if (!query) {
      throw new Error("--query is required for search");
    }

    const limitRaw = getStringOption(options, "limit");
    const limit = limitRaw ? Number(limitRaw) : 5;

    const requestType = getStringOption(options, "request-type");
    const result = searchLogEvidence({
      query,
      limit,
      requestResponseType:
        requestType === "request" ||
        requestType === "response" ||
        requestType === "unknown" ||
        requestType === "both"
          ? requestType
          : "both",
      source: getStringOption(options, "source") ?? undefined,
      host: getStringOption(options, "host") ?? undefined,
      pathKeyword: getStringOption(options, "path-keyword") ?? undefined,
      includeRaw: getBooleanOption(options, "include-raw"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(usage());
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
