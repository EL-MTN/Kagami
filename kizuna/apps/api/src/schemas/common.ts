import { z } from "zod";

export const ObjectIdString = z.string().regex(/^[a-f0-9]{24}$/i, "must be a 24-char hex ObjectId");

export const IdParam = z.object({ id: ObjectIdString });

export const ISODateString = z.string().datetime({ offset: true });

export const DateInput = z
  .string()
  .min(1)
  .superRefine((s, ctx) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid date" });
    }
  });

export const BoolFlag = z.enum(["true", "false"]).transform((v) => v === "true");

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
