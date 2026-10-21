/**
 * An in-memory stand-in for the four Parameter Store calls the console layer and the pipeline's
 * config route make.
 *
 * Moved from `__tests__/lib/console/fakeSsm.ts`; the module factory it used to carry
 * (`ssmCommandMocks`) is now `awsMocks.ssmModule`. Route the mocked client's `send` here. The fake
 * keeps a `Map` of parameter names to values and honours the two behaviours the code under test
 * depends on: `GetParametersByPath` paginates (with a configurable page size, so a test can force a
 * second page without storing eleven parameters) and `GetParameter`/`DeleteParameter` throw an error
 * named `ParameterNotFound` for an absent name, because the code distinguishes that from any other
 * failure.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 */

export interface FakeSsmCommand {
  __cmd: "Get" | "GetByPath" | "Put" | "Delete";
  Name?: string;
  Value?: string;
  Path?: string;
  NextToken?: string;
  Recursive?: boolean;
  Type?: string;
  Overwrite?: boolean;
}

export interface FakeSsm {
  /** Parameter name -> value. Seed it directly, or through `seed`. */
  store: Map<string, string>;
  /** Handle one command the way the real service would. */
  send: (cmd: FakeSsmCommand) => Promise<unknown>;
  /** Store several parameters at once, relative to a prefix. */
  seed: (prefix: string, values: Record<string, string>) => void;
}

/** An error shaped the way the SDK shapes a missing parameter. */
export function parameterNotFound(): Error {
  return Object.assign(new Error("ParameterNotFound"), { name: "ParameterNotFound" });
}

/**
 * @param pageSize how many parameters one `GetParametersByPath` page carries (the service caps it at ten).
 */
export function createFakeSsm(pageSize = 10): FakeSsm {
  const store = new Map<string, string>();
  return {
    store,
    seed(prefix, values) {
      for (const [key, value] of Object.entries(values)) store.set(`${prefix}/${key}`, value);
    },
    async send(cmd) {
      switch (cmd.__cmd) {
        case "Get": {
          const value = store.get(cmd.Name ?? "");
          if (value === undefined) throw parameterNotFound();
          return { Parameter: { Name: cmd.Name, Value: value } };
        }
        case "GetByPath": {
          const path = `${cmd.Path ?? ""}/`;
          const names = [...store.keys()].filter((n) => n.startsWith(path)).sort();
          const start = cmd.NextToken ? Number(cmd.NextToken) : 0;
          const page = names.slice(start, start + pageSize);
          return {
            Parameters: page.map((n) => ({ Name: n, Value: store.get(n) })),
            NextToken: start + pageSize < names.length ? String(start + pageSize) : undefined,
          };
        }
        case "Put":
          store.set(cmd.Name ?? "", cmd.Value ?? "");
          return { Version: 1 };
        case "Delete":
          if (!store.has(cmd.Name ?? "")) throw parameterNotFound();
          store.delete(cmd.Name ?? "");
          return {};
      }
    },
  };
}
