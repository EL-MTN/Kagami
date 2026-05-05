import { Schema, model } from "mongoose";
import { baseSchemaOptions, provenanceFields } from "./base.js";

const OAuthTokenSchema = new Schema(
  {
    provider: { type: String, required: true, enum: ["google"], unique: true },
    refreshToken: { type: String, required: true },
    scopes: { type: [String], default: [] },
    grantedAt: { type: Date, required: true },
    ...provenanceFields,
  },
  baseSchemaOptions,
);

OAuthTokenSchema.index({ deletedAt: 1 }, { sparse: true });

export const OAuthToken = model("OAuthToken", OAuthTokenSchema);
export type OAuthTokenDoc = ReturnType<(typeof OAuthToken)["hydrate"]>;
