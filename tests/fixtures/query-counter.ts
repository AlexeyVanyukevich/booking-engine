import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely'

/**
 * Counts the queries a Kysely instance executes, including those inside a transaction, so a
 * test can assert how a code path's query count grows. Attach with `db.withPlugin(counter)`;
 * the handle it returns shares the original's connection pool.
 */
export class QueryCounter implements KyselyPlugin {
  count = 0

  reset(): void {
    this.count = 0
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    this.count++
    return args.node
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result
  }
}
