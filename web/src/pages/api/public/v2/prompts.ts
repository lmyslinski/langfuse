import { verifyAuthHeaderAndReturnScope } from "@/src/features/public-api/server/apiAuth";
import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import { isPrismaException } from "@/src/utils/exceptions";
import { paginationZod } from "@/src/utils/zod";
import { prisma } from "@langfuse/shared/src/db";
import { type NextApiRequest, type NextApiResponse } from "next";
import { z } from "zod";
import { type Prompt } from "../../../../../../packages/shared/dist/prisma/generated/types";

const GetPromptsSchema = z.object({
  ...paginationZod,
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await runMiddleware(req, res, cors);
  if (req.method === "GET") {
    const authCheck = await verifyAuthHeaderAndReturnScope(
      req.headers.authorization,
    );
    if (!authCheck.validKey)
      return res.status(401).json({
        message: authCheck.error,
      });

    console.log(
      "trying to get prompt list",
      authCheck.scope.projectId,
      ", body:",
      JSON.stringify(req.query, null, 2),
    );

    if (authCheck.scope.accessLevel !== "all") {
      return res.status(401).json({
        message:
          "Access denied - need to use basic auth with secret key to GET prompts",
      });
    }
    try {
      const obj = GetPromptsSchema.parse(req.query);
      const skipValue = (obj.page - 1) * obj.limit;
      const prompts = await prisma.$queryRaw<Array<Prompt>>`
        SELECT 
          id, 
          name, 
          version as "latestVersion", 
          project_id AS "projectId", 
          prompt, 
          updated_at AS "updatedAt", 
          created_at AS "createdAt", 
          is_active AS "isActive"
        FROM prompts
        WHERE (name, version) IN (
          SELECT name, MAX(version)
          FROM prompts
          WHERE "project_id" = ${authCheck.scope.projectId}
          GROUP BY name
        )
        AND "project_id" = ${authCheck.scope.projectId}
        ORDER BY name ASC
        LIMIT ${obj.limit} OFFSET ${skipValue}
        `;

      const response_count_response = await prisma.$queryRaw<
        Array<{
          prompt_name_count: BigInt;
        }>
      >`
        SELECT 
          COUNT(DISTINCT name) AS prompt_name_count 
        FROM prompts 
        WHERE project_id = ${authCheck.scope.projectId};
      `;

      const total = Number(response_count_response[0].prompt_name_count);

      return res.status(200).json({
        data: prompts,
        meta: {
          page: obj.page,
          limit: obj.limit,
          totalItems: total,
          totalPages: Math.ceil(total / obj.limit),
        },
      });
    } catch (error: unknown) {
      console.error(error);
      if (isPrismaException(error)) {
        return res.status(500).json({
          error: "Internal Server Error",
        });
      }
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid request data",
          error: error.errors,
        });
      }
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred";
      res.status(500).json({
        message: "Invalid request data",
        error: errorMessage,
      });
    }
  } else {
    console.error(req.method, req.body, req.query);
    return res.status(405).json({ message: "Method not allowed" });
  }
}
