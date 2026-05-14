import { MongoMemoryReplSet } from "mongodb-memory-server";

export const SHARED_MONGO_URI_ENV = "__KANSOKU_SHARED_MONGO_URI__";

let replSet: MongoMemoryReplSet | undefined;

export default async function setup(): Promise<() => Promise<void>> {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env[SHARED_MONGO_URI_ENV] = replSet.getUri();

  return async () => {
    await replSet?.stop();
    replSet = undefined;
    delete process.env[SHARED_MONGO_URI_ENV];
  };
}
