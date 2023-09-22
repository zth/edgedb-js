import { $, adapter, type Client } from "edgedb";
import { Cardinality } from "edgedb/dist/ifaces";
import { type CommandOptions } from "./commandutil";
import { headerComment } from "./genutil";
import type { Target } from "./genutil";

const rescriptExtensionPointRegex = /let\s+(\w+)\s+=\s+%edgedb\(`([^`]+)`\)/g;

interface Queries {
  bindingName: string;
  query: string;
  types: QueryType;
}

// generate per-file queries
// generate queries in a single file
// generate per-file queries, then listen for changes and update
export async function generateQueryFiles(params: {
  root: string | null;
  options: CommandOptions;
  client: Client;
}) {
  if (params.options.file && params.options.watch) {
    throw new Error(`Using --watch and --file mode simultaneously is not
currently supported.`);
  }

  const noRoot = !params.root;
  const root = params.root ?? adapter.process.cwd();
  if (noRoot) {
    console.warn(
      `No \`edgedb.toml\` found, using process.cwd() as root directory:
   ${params.root}
`
    );
  } else {
    console.log(`Detected project root via edgedb.toml:`);
    console.log("   " + params.root);
  }

  const { client } = params;

  // file mode: introspect all queries and generate one file
  // generate one query per file

  const matches = await getMatches(root);
  if (matches.length === 0) {
    console.log(`No .res files found in project`);
    return;
  }

  console.log(`Connecting to database...`);
  await client.ensureConnected();

  console.log(`Analyzing .res files...`);

  async function generateFilesForQuery(path: string) {
    try {
      let fileText = await adapter.readFileUtf8(path);
      if (fileText.includes("%edgedb(")) {
        console.log("Has extension node...");
        const queries: Queries[] = await Promise.all(
          [...fileText.matchAll(rescriptExtensionPointRegex)].map(
            async (q) => ({
              bindingName: q[1],
              query: q[2],
              types: await $.analyzeQuery(client, q[2]),
            })
          )
        );
        const files = generateFiles({
          target: params.options.target!,
          path,
          queries,
        });
        for (const f of files) {
          const prettyPath = "./" + adapter.path.posix.relative(root, f.path);
          console.log(`   ${prettyPath}`);
          await adapter.fs.writeFile(
            adapter.path.join("__generated__", f.path),
            headerComment + `${stringifyImports(f.imports)}\n\n${f.contents}`
          );
        }
      }
    } catch (err) {
      console.log(
        `Error in file './${adapter.path.posix.relative(root, path)}': ${(
          err as any
        ).toString()}`
      );
    }
  }

  // generate per-query files
  console.log(`Generating files for following queries:`);
  await Promise.all(matches.map(generateFilesForQuery));

  if (!params.options.watch) {
    adapter.exit();
    return;
  }

  // find all *.edgeql files
  // for query in queries:
  //   generate output file
}

function stringifyImports(imports: { [k: string]: boolean }) {
  if (Object.keys(imports).length === 0) return "";
  return `import type {${Object.keys(imports).join(", ")}} from "edgedb";`;
}

async function getMatches(root: string) {
  return adapter.walk(root, {
    match: [/[^\/]\.res$/],
    skip: [/node_modules/, RegExp(`dbschema\\${adapter.path.sep}migrations`)],
  });
}

type QueryType = Awaited<ReturnType<(typeof $)["analyzeQuery"]>>;

function generateFiles(params: {
  target: Target;
  path: string;
  queries: Queries[];
}): {
  path: string;
  contents: string;
  imports: { [k: string]: boolean };
  extension: string;
}[] {
  const queryFileName = adapter.path.basename(params.path, ".res");
  const baseFileName = queryFileName;
  const outputBaseFileName = `${baseFileName}__edgeDbQueries`;
  let fileOutput = "";

  params.queries.forEach((params) => {
    const method =
      params.types.cardinality === Cardinality.ONE
        ? "queryRequiredSingle"
        : params.types.cardinality === Cardinality.AT_MOST_ONE
        ? "querySingle"
        : "query";
    const hasArgs = params.types.args && params.types.args !== "null";
    const functionBody = `\
${params.types.query.trim().replace(/`/g, "\\`")}\`${hasArgs ? `, ~args` : ""});
`;

    fileOutput += `module ${params.bindingName[0].toUpperCase()}${params.bindingName.slice(
      1
    )} = {
${[...params.types.distinctTypes].join("\n\n")}

  let query = (client: EdgeDB.Executor.t${
    hasArgs ? `, args: args` : ""
  }): promise<response> => {
    client->EdgeDB.Executor.${method}(\`\\
    ${functionBody}
  }
}\n\n`;
  });

  return [
    {
      path: `${outputBaseFileName}.res`,
      contents: fileOutput,
      imports: {},
      extension: ".res",
    },
  ];
}