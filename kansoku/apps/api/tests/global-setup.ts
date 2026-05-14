import { MongoMemoryReplSet } from "mongodb-memory-server";

export const SHARED_MONGO_URI_ENV = "__KANSOKU_SHARED_MONGO_URI__";

let replSet: MongoMemoryReplSet | undefined;

export default async function setup(): Promise<() => Promise<void>> {
  try {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env[SHARED_MONGO_URI_ENV] = replSet.getUri();
  } catch (err) {
    // mongodb-memory-server downloads the Mongo binary on first use; in some
    // environments (offline sandboxes, fresh distros without a published
    // build) that download fails. Don't take down every test — suites that
    // need Mongo will throw at setupTestMongo when SHARED_MONGO_URI_ENV is
    // unset, but non-Mongo suites (e.g. SSE tail) still run.
    // eslint-disable-next-line no-console
    console.warn(
      `[kansoku tests] could not start mongodb-memory-server: ${(err as Error).message}. ` +
        `Mongo-backed suites will be skipped.`,
    );
  }

  return async () => {
    await replSet?.stop();
    replSet = undefined;
    delete process.env[SHARED_MONGO_URI_ENV];
  };
}
