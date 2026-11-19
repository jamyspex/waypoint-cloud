import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import { timingSafeEqual } from "node:crypto";

const ssm = new SSMClient({});
const hexToken = /^[a-f0-9]{64}$/;

export async function handler(event: APIGatewayRequestAuthorizerEventV2) {
  const authorization = event.headers?.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!hexToken.test(token)) return { isAuthorized: false };

  try {
    const { Parameter } = await ssm.send(new GetParameterCommand({
      Name: process.env.TOKEN_PARAMETER,
      WithDecryption: true,
    }));
    const expected = Parameter?.Value;
    return {
      isAuthorized: typeof expected === "string" && hexToken.test(expected)
        && timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex")),
    };
  } catch (error) {
    console.error("Device credential unavailable", error instanceof Error ? error.name : "UnknownError");
    return { isAuthorized: false };
  }
}
