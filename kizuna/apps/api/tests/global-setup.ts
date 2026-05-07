import { MongoMemoryServer } from "mongodb-memory-server";

export const SHARED_MONGO_URI_ENV = "__VITEST_SHARED_MONGO_URI__";

let server: MongoMemoryServer | undefined;

export default async function setup(): Promise<() => Promise<void>> {
  server = await MongoMemoryServer.create();
  process.env[SHARED_MONGO_URI_ENV] = server.getUri();

  return async () => {
    await server?.stop();
    server = undefined;
    delete process.env[SHARED_MONGO_URI_ENV];
  };
}
