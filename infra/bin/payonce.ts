import { App, LegacyStackSynthesizer, Tags } from "aws-cdk-lib";
import { CERT_REGION, CertStack } from "../lib/cert-stack.js";
import { PayOnceStack, REGION } from "../lib/payonce-stack.js";

export const DOMAIN: string = "payonce.jagnani73.com";

// The PayOnce stack. Run with an aws login session and the budgets' alert address:
//   pnpm cdk synth --profile payonce -c alertEmail=you@example.com
const app: App = new App();
const alertEmail: unknown = app.node.tryGetContext("alertEmail");
if (typeof alertEmail !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alertEmail)) {
  throw new Error("Give the budgets' alert address: -c alertEmail=you@example.com");
}
// The PayOnceCert stack's output, once ACM has issued it: -c certificateArn=arn:aws:acm:us-east-1:...
const certificateArn: unknown = app.node.tryGetContext("certificateArn");
if (certificateArn !== undefined && (typeof certificateArn !== "string" || !/^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]+$/.test(certificateArn))) {
  throw new Error("certificateArn must be the PayOnceCert stack's us-east-1 ACM certificate ARN");
}
const account: string | undefined = process.env["CDK_DEFAULT_ACCOUNT"];
if (account === undefined) {
  throw new Error("No AWS account found. Run aws login --profile payonce, then pass --profile payonce");
}

// The public domain's certificate, in us-east-1 for CloudFront. Its ARN reaches the
// main stack as context (-c certificateArn=...) once ACM has validated it, which
// avoids a cross-region reference and its custom resource.
new CertStack(app, "PayOnceCert", {
  env: { account, region: CERT_REGION },
  synthesizer: new LegacyStackSynthesizer(),
  analyticsReporting: false,
  description: "PayOnce live demo: the public domain's certificate",
  domain: DOMAIN,
});

new PayOnceStack(app, "PayOnce", {
  env: { account, region: REGION },
  // Needs no bootstrap stack: the template goes to CloudFormation inline, and the
  // stack has no file or Docker assets.
  synthesizer: new LegacyStackSynthesizer(),
  analyticsReporting: false,
  description: "PayOnce live demo: one EC2 instance behind CloudFront",
  alertEmail,
  // Both or neither: the domain goes on the distribution only with its certificate.
  ...(typeof certificateArn === "string" && /^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]+$/.test(certificateArn)
    ? { domain: DOMAIN, certificateArn }
    : {}),
});
Tags.of(app).add("project", "payonce");
