import { z } from "zod";

export type EndpointSpec = {
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  description: string;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  response?: z.ZodTypeAny;
};

export type ManifestEndpoint = {
  name: string;
  method: string;
  path: string;
  description: string;
  params?: unknown;
  query?: unknown;
  body?: unknown;
  response?: unknown;
};

export function buildManifest(endpoints: EndpointSpec[]): {
  version: string;
  endpoints: ManifestEndpoint[];
} {
  const toJson = (s: z.ZodTypeAny, name: string) =>
    z.toJSONSchema(s, {
      target: "draft-07",
      io: "input",
      reused: "ref",
      unrepresentable: "any",
      override: ({ jsonSchema }) => {
        if (typeof jsonSchema === "object" && jsonSchema !== null) {
          jsonSchema.title = name;
        }
      },
    });

  return {
    version: "v1",
    endpoints: endpoints.map((e) => {
      const out: ManifestEndpoint = {
        name: e.name,
        method: e.method,
        path: e.path,
        description: e.description,
      };
      if (e.params) out.params = toJson(e.params, `${e.name}.params`);
      if (e.query) out.query = toJson(e.query, `${e.name}.query`);
      if (e.body) out.body = toJson(e.body, `${e.name}.body`);
      if (e.response) out.response = toJson(e.response, `${e.name}.response`);
      return out;
    }),
  };
}
